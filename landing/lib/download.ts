export const APP_VERSION = '0.1.04'

export const RELEASES_URL = '/releases'

export const LATEST_RELEASE_URL = '/releases#latest'

export const WINDOWS_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_INSTALLER_URL?.trim() || '/download'

export const INSTALLER_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_INSTALLER_URL?.trim() || '/releases#latest'
