/** `runner.py`'s slug(): lowercase, non-alphanumerics collapsed to hyphens. */
export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
