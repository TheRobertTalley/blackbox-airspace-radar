/*
 * Receive-only Windows bridge derived from Nuand/bladeRF-adsb.
 * Upstream source: https://github.com/Nuand/bladeRF-adsb
 * Upstream license: MIT
 *
 * This fork intentionally contains no transmit module, transmit gain,
 * transmit stream, or arbitrary control interface.
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

#define DEFAULT_FPGA_PATH "adsbx40.rbf"
#define DEFAULT_DECODER_HOST "127.0.0.1"
#define DEFAULT_DECODER_PORT 30001
#define RX_SAMPLES_PER_BUFFER 1024
#define RX_BYTES_PER_SAMPLE 4

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

static int configure_receiver(struct bladerf *device) {
    int status;
    status = bladerf_set_frequency(device, BLADERF_MODULE_RX, 1086000000u);
    if (status != 0) return status;
    status = bladerf_set_sample_rate(device, BLADERF_MODULE_RX, 16000000u, NULL);
    if (status != 0) return status;
    status = bladerf_set_bandwidth(device, BLADERF_MODULE_RX, 14000000u, NULL);
    if (status != 0) return status;

    status = bladerf_set_gain_mode(device, BLADERF_CHANNEL_RX(0), BLADERF_GAIN_MGC);
    if (status != 0) return status;
    return bladerf_set_gain(device, BLADERF_CHANNEL_RX(0), 35);
}

int main(int argc, char **argv) {
    const char *fpga_path = argc > 1 ? argv[1] : DEFAULT_FPGA_PATH;
    const char *decoder_host = argc > 2 ? argv[2] : DEFAULT_DECODER_HOST;
    unsigned short decoder_port = argc > 3 ? (unsigned short)strtoul(argv[3], NULL, 10) : DEFAULT_DECODER_PORT;
    struct bladerf *device = NULL;
    bladerf_fpga_size fpga_size;
    uint8_t messages[RX_SAMPLES_PER_BUFFER * RX_BYTES_PER_SAMPLE];
    char frame[32];
    SOCKET decoder = INVALID_SOCKET;
    WSADATA winsock;
    int status = 1;

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);
    bladerf_log_set_verbosity(BLADERF_LOG_LEVEL_CRITICAL);
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

    fprintf(stderr, "loading receive-only ADS-B FPGA: %s\n", fpga_path);
    status = bladerf_load_fpga(device, fpga_path);
    if (status < 0) {
        fprintf(stderr, "FPGA load failed: %s\n", bladerf_strerror(status));
        goto cleanup;
    }
    bladerf_close(device);
    device = NULL;

    status = bladerf_open(&device, NULL);
    if (status < 0) goto cleanup;
    status = configure_receiver(device);
    if (status < 0) {
        fprintf(stderr, "RX configuration failed: %s\n", bladerf_strerror(status));
        goto cleanup;
    }
    status = bladerf_sync_config(device, BLADERF_MODULE_RX,
                                 BLADERF_FORMAT_SC16_Q11, 2,
                                 RX_SAMPLES_PER_BUFFER, 1, 60000);
    if (status < 0) goto cleanup;
    status = bladerf_enable_module(device, BLADERF_MODULE_RX, true);
    if (status < 0) goto cleanup;

    fprintf(stderr, "RX ONLY: 1090 MHz ADS-B decoder active\n");
    while (keep_running) {
        int index;
        status = bladerf_sync_rx(device, messages, RX_SAMPLES_PER_BUFFER, NULL, 60000);
        if (status == BLADERF_ERR_TIMEOUT) continue;
        if (status < 0) {
            fprintf(stderr, "RX read failed: %s\n", bladerf_strerror(status));
            break;
        }

        for (index = 0; index < (int)sizeof(messages); index += 16) {
            int byte_index;
            int payload_length;
            if ((messages[index] & 0x01u) == 0) continue;
            payload_length = (messages[index + 2] & 0x80u) ? 14 : 7;
            frame[0] = '*';
            for (byte_index = 0; byte_index < payload_length; ++byte_index) {
                sprintf(frame + 1 + byte_index * 2, "%02x", messages[index + 2 + byte_index]);
            }
            strcpy(frame + 1 + payload_length * 2, ";\n");

            if (decoder == INVALID_SOCKET) {
                decoder = connect_decoder(decoder_host, decoder_port);
            }
            if (decoder != INVALID_SOCKET &&
                send(decoder, frame, (int)strlen(frame), 0) == SOCKET_ERROR) {
                closesocket(decoder);
                decoder = INVALID_SOCKET;
            }
            fputs(frame, stdout);
            fflush(stdout);
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
