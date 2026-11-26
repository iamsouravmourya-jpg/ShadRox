export const APP_VERSION = '0.1.4'

export const RELEASES_URL = 'https://github.com/iamsouravmourya-jpg/ShadRox/releases'

export const LATEST_RELEASE_URL = 'https://github.com/iamsouravmourya-jpg/ShadRox/releases/tag/v0.1.4'

export const WINDOWS_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_INSTALLER_URL?.trim() || LATEST_RELEASE_URL

export const INSTALLER_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_INSTALLER_URL?.trim() || LATEST_RELEASE_URL
