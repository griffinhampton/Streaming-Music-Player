"""
Where things live, whether running from source or from a packaged .exe.

Two different roots matter:
  resource_dir  read-only stuff we ship (web/, smtc.ps1). PyInstaller unpacks
                this into a temp folder that is wiped on exit.
  data_dir      things people own (config.json, cache/, uploaded art). Must sit
                next to the .exe so settings survive a restart.
"""

import os
import sys

FROZEN = getattr(sys, "frozen", False)


def resource_dir():
    if FROZEN:
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def data_dir():
    if FROZEN:
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def builtin_dir():
    """The artwork that ships with the app.

    From source it sits beside the project as "built in themes"; in the .exe it
    is bundled as "builtin".
    """
    if FROZEN:
        return os.path.join(resource_dir(), "builtin")
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "built in themes")


def resource(*parts):
    return os.path.join(resource_dir(), *parts)


def data(*parts):
    path = os.path.join(data_dir(), *parts)
    return path
