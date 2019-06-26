export function b64toBlob(dataURI: string, name: string) {
  var byteString = atob(dataURI.split(',')[1]);
  var ab = new ArrayBuffer(byteString.length);
  var ia = new Uint8Array(ab);
  for (var i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new File([ab], name, {
    type: dataURI.replace(/(.*:)|;(.*)/g, ''),
  });
}
