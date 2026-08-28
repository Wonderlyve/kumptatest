(function(){
  const ORIG = 'https://ideagrouperdc.com';
  const PROXY = '/api/proxy/ideagrouperdc.com';

  // Patch fetch
  if (window.fetch) {
    const _fetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          if (input.startsWith(ORIG)) input = input.replace(ORIG, PROXY);
        } else if (input && input.url && typeof input.url === 'string') {
          if (input.url.startsWith(ORIG)) {
            const newUrl = input.url.replace(ORIG, PROXY);
            input = new Request(newUrl, input);
          }
        }
      } catch (e) {
        console.warn('api-proxy-client fetch rewrite failed', e);
      }
      return _fetch(input, init);
    };
  }

  // Patch XMLHttpRequest.open
  try {
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try {
        if (typeof url === 'string' && url.startsWith(ORIG)) {
          url = url.replace(ORIG, PROXY);
        }
      } catch (e) {
        console.warn('api-proxy-client XHR rewrite failed', e);
      }
      return _open.call(this, method, url, ...rest);
    };
  } catch (e) {
    // ignore
  }

})();
