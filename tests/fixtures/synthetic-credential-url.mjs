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
