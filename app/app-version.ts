import packageJson from "../package.json";

/** Single release source used by the dashboard, login screen and footer. */
export const APP_VERSION = packageJson.version;
export const APP_VERSION_LABEL = `V ${APP_VERSION}`;
