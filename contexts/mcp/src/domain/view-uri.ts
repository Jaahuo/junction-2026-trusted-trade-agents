/** Hex characters of the view HTML's SHA-256 that make up its version (SPEC-013). */
const VIEW_VERSION_LENGTH = 12;

/** The version of a view from the hex SHA-256 of its HTML. */
export const viewVersion = (sha256Hex: string): string => sha256Hex.slice(0, VIEW_VERSION_LENGTH);

/** `ui://trusted-trade/<view>/<version>`: a changed view gets a new URI, so a host cache cannot serve the old HTML. */
export const versionedViewUri = (baseUri: string, version: string): string =>
  `${baseUri}/${version}`;
