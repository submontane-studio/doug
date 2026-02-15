// worker-patch.js
// Chrome拡張のWorker内ではimportScripts(chrome-extension://...)が失敗するため、
// Blobコンストラクタを上書きし、importScriptsを含むBlobの内容を差し替える
//
// 解決策: chrome-extension:// URLを同期XHRで取得 → Blob化 → blob: URL経由で
// オリジナルのimportScriptsを呼ぶ（evalは使わない → CSP準拠）

(function() {
  var _OrigBlob = Blob;

  // Worker内でimportScriptsを置き換えるコード（evalなし）
  // chrome-extension:// URL → sync XHR → Blob → blob: URL → _origImportScripts
  var importScriptsShim = [
    'var _origImportScripts = self.importScripts.bind(self);',
    'self.importScripts = function() {',
    '  for (var i = 0; i < arguments.length; i++) {',
    '    var url = arguments[i];',
    '    if (url.startsWith("blob:")) {',
    '      _origImportScripts(url);',
    '    } else {',
    '      var xhr = new XMLHttpRequest();',
    '      xhr.open("GET", url, false);',
    '      xhr.send();',
    '      if (xhr.status >= 200 && xhr.status < 300) {',
    '        var b = new Blob([xhr.responseText], {type:"application/javascript"});',
    '        var bUrl = URL.createObjectURL(b);',
    '        _origImportScripts(bUrl);',
    '        URL.revokeObjectURL(bUrl);',
    '      } else {',
    '        throw new Error("importScripts failed: " + url + " status=" + xhr.status);',
    '      }',
    '    }',
    '  }',
    '};',
  ].join('\n');

  Blob = function(parts, options) {
    if (parts && parts.length === 1 && typeof parts[0] === 'string') {
      var src = parts[0];
      var match = src.match(/^importScripts\("(.+)"\);?$/);
      if (match) {
        var scriptUrl = match[1];
        console.log('[Doug worker-patch] importScripts Blob検出:', scriptUrl);
        try {
          // worker.min.jsの内容を取得し、shimと結合してBlobに入れる
          var xhr = new XMLHttpRequest();
          xhr.open('GET', scriptUrl, false);
          xhr.send();
          if (xhr.status >= 200 && xhr.status < 300) {
            console.log('[Doug worker-patch] スクリプト取得成功, サイズ:', xhr.responseText.length);
            parts = [importScriptsShim + '\n' + xhr.responseText];
          } else {
            console.error('[Doug worker-patch] スクリプト取得失敗:', xhr.status);
          }
        } catch (e) {
          console.error('[Doug worker-patch] XHRエラー:', e);
        }
      }
    }
    return new _OrigBlob(parts, options);
  };
  Blob.prototype = _OrigBlob.prototype;
  Object.defineProperty(Blob, Symbol.hasInstance, {
    value: function(obj) { return obj instanceof _OrigBlob; }
  });
})();
