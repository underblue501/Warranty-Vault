/* No background service worker: MV3 backgrounds differ between Chrome
   (service_worker) and Firefox (scripts), and Orion runs builds of both.
   A popup that opens a tab and closes behaves the same everywhere, and
   tabs.create needs no "tabs" permission. */
const api = globalThis.browser || globalThis.chrome;

function showFallback(){
  document.getElementById('msg').textContent = 'Warranty Vault could not open a tab automatically.';
  document.getElementById('fallback').hidden = false;
}

try{
  const url = api.runtime.getURL('index.html');
  document.getElementById('link').href = url;
  const created = api.tabs.create({ url });
  if(created && typeof created.then === 'function'){
    created.then(() => window.close(), showFallback);
  } else {
    window.close();
  }
}catch(e){
  showFallback();
}
