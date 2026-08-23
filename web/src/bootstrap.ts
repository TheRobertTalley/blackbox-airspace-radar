const githubPagesHost = 'theroberttalley.github.io';
const receiverPage = 'https://blackbox.tailade622.ts.net/';

if (location.hostname === githubPagesHost) {
  const frame = document.createElement('iframe');
  frame.src = receiverPage;
  frame.title = 'BlackBox Airspace live radar';
  frame.setAttribute('allow', 'local-network-access');
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#071018;color-scheme:dark';
  document.body.replaceChildren(frame);
  document.body.style.margin = '0';
  document.body.style.background = '#071018';
} else {
  void import('./main');
}
