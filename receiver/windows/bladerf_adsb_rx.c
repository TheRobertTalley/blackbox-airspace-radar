/*
 * Receive-only bladeRF Classic x40 IQ bridge for readsb.
 *
 * The board runs Nuand's supported hosted FPGA. This process configures RX at
 * 1090 MHz and streams SC16Q11 IQ samples to readsb over a local TCP socket.
 * It intentionally contains no transmit module, transmit gain, transmit
 * stream, arbitrary radio-control interface, or FPGA-writing operation.
 */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <inttypes.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libbladeRF.h>

#define DEFAULT_DECODER_HOST "127.0.0.1"
#define DEFAULT_DECODER_PORT 30005
#define RX_SAMPLE_RATE 2400000u
#define RX_FREQUENCY 1090000000u
#define RX_BANDWIDTH 2500000u
#define RX_SAMPLES_PER_BUFFER 8192
#define RX_NUM_BUFFERS 16
#define RX_NUM_TRANSFERS 8

static volatile sig_atomic_t keep_running = 1;

static void handle_signal(int signal_number) {
    (void)signal_number;
    keep_running = 0;
}

static SOCKET connect_decoder(const char *host, unsigned short port) {
    struct sockaddr_in address;
    SOCKET socket_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_fd == INVALID_SOCKET) {
        return INVALID_SOCKET;
    }

    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (inet_pton(AF_INET, host, &address.sin_addr) != 1 ||
        connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR) {
        closesocket(socket_fd);
        return INVALID_SOCKET;
    }
    return socket_fd;
}

static bool send_all(SOCKET socket_fd, const uint8_t *data, size_t length) {
    size_t sent = 0;
    while (sent < length) {
        int chunk = send(socket_fd, (const char *)data + sent,
                         (int)(length - sent), 0);
        if (chunk == SOCKET_ERROR || chunk == 0) {
            return false;
        }
        sent += (size_t)chunk;
    }
    return true;
}

static int configure_receiver(struct bladerf *device) {
    int status;
    status = bladerf_set_frequency(device, BLADERF_MODULE_RX, RX_FREQUENCY);
    if (status != 0) return status;
    status = bladerf_set_sample_rate(device, BLADERF_MODULE_RX, RX_SAMPLE_RATE, NULL);
    if (status != 0) return status;
    status = bladerf_set_bandwidth(device, BLADERF_MODULE_RX, RX_BANDWIDTH, NULL);
    if (status != 0) return status;
    status = bladerf_set_gain_mode(device, BLADERF_CHANNEL_RX(0), BLADERF_GAIN_MGC);
    if (status != 0) return status;

    /* These settings were measured on this board at 1090 MHz immediately
     * after the firmware upgrade. They produced valid live Mode-S frames. */
    status = bladerf_set_gain(device, BLADERF_CHANNEL_RX(0), 22);
    if (status != 0) return status;
    status = bladerf_set_correction(device, BLADERF_MODULE_RX,
                                    BLADERF_CORR_LMS_DCOFF_I, 416);
    if (status != 0) return status;
    return bladerf_set_correction(device, BLADERF_MODULE_RX,
                                  BLADERF_CORR_LMS_DCOFF_Q, 864);
}

int main(int argc, char **argv) {
    const char *decoder_host = argc > 1 ? argv[1] : DEFAULT_DECODER_HOST;
    unsigned short decoder_port = argc > 2
        ? (unsigned short)strtoul(argv[2], NULL, 10)
        : DEFAULT_DECODER_PORT;
    struct bladerf *device = NULL;
    bladerf_fpga_size fpga_size;
    struct bladerf_version firmware_version;
    struct bladerf_version fpga_version;
    int16_t samples[RX_SAMPLES_PER_BUFFER * 2];
    SOCKET decoder = INVALID_SOCKET;
    WSADATA winsock;
    uint64_t buffers_read = 0;
    uint64_t samples_read = 0;
    uint64_t bytes_forwarded = 0;
    uint64_t receive_timeouts = 0;
    ULONGLONG next_status_at;
    int status = 1;

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);
    bladerf_log_set_verbosity(BLADERF_LOG_LEVEL_WARNING);
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
        fprintf(stderr, "winsock initialization failed\n");
        return 1;
    }

    status = bladerf_open(&device, NULL);
    if (status < 0) {
        fprintf(stderr, "bladeRF open failed: %s\n", bladerf_strerror(status));
        goto cleanup;
    }
    status = bladerf_get_fpga_size(device, &fpga_size);
    if (status < 0 || fpga_size != BLADERF_FPGA_40KLE) {
        fprintf(stderr, "receiver requires a bladeRF Classic x40\n");
        status = 2;
        goto cleanup;
    }
    status = bladerf_fw_version(device, &firmware_version);
    if (status < 0) goto cleanup;
    status = bladerf_fpga_version(device, &fpga_version);
    if (status < 0) goto cleanup;
    if (firmware_version.major < 2 ||
        (firmware_version.major == 2 && firmware_version.minor < 6) ||
        (fpga_version.major == 0 && fpga_version.minor < 16)) {
        fprintf(stderr,
                "unsupported board stack: firmware=%u.%u.%u fpga=%u.%u.%u; "
                "requires firmware >=2.6.0 and hosted FPGA >=0.16.0\n",
                firmware_version.major, firmware_version.minor, firmware_version.patch,
                fpga_version.major, fpga_version.minor, fpga_version.patch);
        status = 3;
        goto cleanup;
    }

    status = configure_receiver(device);
    if (status < 0) {
        fprintf(stderr, "RX configuration failed: %s\n", bladerf_strerror(status));
        goto cleanup;
    }
    status = bladerf_sync_config(device, BLADERF_MODULE_RX,
                                 BLADERF_FORMAT_SC16_Q11, RX_NUM_BUFFERS,
                                 RX_SAMPLES_PER_BUFFER, RX_NUM_TRANSFERS, 5000);
    if (status < 0) {
        fprintf(stderr, "RX stream configuration failed: %s\n", bladerf_strerror(status));
        goto cleanup;
    }
    status = bladerf_enable_module(device, BLADERF_MODULE_RX, true);
    if (status < 0) goto cleanup;

    decoder = connect_decoder(decoder_host, decoder_port);
    fprintf(stderr,
            "RX ONLY: 1090 MHz SC16Q11 stream active; firmware=%u.%u.%u "
            "fpga=%u.%u.%u decoder=%s:%u (%s)\n",
            firmware_version.major, firmware_version.minor, firmware_version.patch,
            fpga_version.major, fpga_version.minor, fpga_version.patch,
            decoder_host, decoder_port,
            decoder == INVALID_SOCKET ? "disconnected" : "connected");
    next_status_at = GetTickCount64() + 10000;

    while (keep_running) {
        status = bladerf_sync_rx(device, samples, RX_SAMPLES_PER_BUFFER, NULL, 5000);
        if (status == BLADERF_ERR_TIMEOUT) {
            receive_timeouts++;
        } else if (status < 0) {
            fprintf(stderr, "RX read failed: %s\n", bladerf_strerror(status));
            break;
        } else {
            const size_t byte_count = sizeof(samples);
            buffers_read++;
            samples_read += RX_SAMPLES_PER_BUFFER;
            if (decoder == INVALID_SOCKET) {
                decoder = connect_decoder(decoder_host, decoder_port);
            }
            if (decoder != INVALID_SOCKET) {
                if (send_all(decoder, (const uint8_t *)samples, byte_count)) {
                    bytes_forwarded += byte_count;
                } else {
                    closesocket(decoder);
                    decoder = INVALID_SOCKET;
                }
            }
        }

        if (GetTickCount64() >= next_status_at) {
            fprintf(stderr,
                    "RX heartbeat: buffers=%" PRIu64 " samples=%" PRIu64
                    " timeouts=%" PRIu64 " bytes_forwarded=%" PRIu64
                    " decoder=%s\n",
                    buffers_read, samples_read, receive_timeouts, bytes_forwarded,
                    decoder == INVALID_SOCKET ? "disconnected" : "connected");
            fflush(stderr);
            next_status_at = GetTickCount64() + 10000;
        }
    }

cleanup:
    if (device != NULL) {
        bladerf_enable_module(device, BLADERF_MODULE_RX, false);
        bladerf_close(device);
    }
    if (decoder != INVALID_SOCKET) closesocket(decoder);
    WSACleanup();
    return status < 0 ? 1 : status;
}
