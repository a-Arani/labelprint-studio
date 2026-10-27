"""Application metadata, shared by the server, the UI (via /api/health) and the build scripts."""

APP_NAME = "LabelPrint Studio"
APP_ID = "LabelPrintStudio"             # used for file names and the per-user data folder
VERSION = "2.1.0"
AUTHOR = "Amirhossein Arani"
REPO_URL = "https://github.com/a-Arani/labelprint-studio"
LICENSE = "MIT"
DESCRIPTION = "Design and print labels on thermal printers (TSC/TSPL) and any Windows printer - free and multilingual"


def as_dict() -> dict:
    return {"name": APP_NAME, "version": VERSION, "author": AUTHOR, "repo": REPO_URL,
            "license": LICENSE, "description": DESCRIPTION}
