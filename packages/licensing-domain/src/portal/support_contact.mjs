// Public support links must not carry credentials or turn a mailto into a query/list.
// eslint-disable-next-line no-control-regex -- reject controls in a single email address
const SUPPORT_MAILTO = /^mailto:[^\s@?,;%\u0000-\u001f\u007f]+@[^\s@?,;%\u0000-\u001f\u007f]+$/iu;

export function parseSupportContact(value) {
  if (SUPPORT_MAILTO.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
}
