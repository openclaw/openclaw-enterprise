/**
 * @param {{
 *   protocol?: string | undefined,
 *   username: string | undefined,
 *   password: string,
 *   host: string,
 *   port?: string | number | undefined,
 *   pathname?: string | undefined,
 *   search?: string | undefined,
 * }} options
 */
export function syntheticCredentialUrl({
  protocol = "https",
  username,
  password,
  host,
  port,
  pathname = "",
  search = "",
}) {
  const endpoint = port === undefined ? host : `${host}:${port}`;
  return `${protocol}://${username}:${password}@${endpoint}${pathname}${search}`;
}
