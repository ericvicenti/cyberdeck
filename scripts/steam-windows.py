#!/usr/bin/env python3
"""Minimize only Steam and Steam-launched game windows; keep their processes/saves intact."""
import ctypes, os, pathlib, subprocess, sys

def steam_pids():
    found = set()
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if p.stat().st_uid != os.getuid(): continue
            # Inspect only the Steam app identifiers. Never print/process other environment values.
            env = (p/'environ').read_bytes().split(b'\0')
            if any(e.startswith((b'SteamAppId=', b'SteamGameId=')) and e.split(b'=',1)[1] not in (b'',b'0') for e in env): found.add(int(p.name))
        except (OSError, PermissionError): pass
    return found

def main():
    if sys.platform != 'linux': return
    windows = subprocess.check_output(['wmctrl','-lpx'],text=True).splitlines()
    pids = steam_pids()
    x = ctypes.CDLL('libX11.so.6')
    x.XOpenDisplay.restype=ctypes.c_void_p
    x.XIconifyWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int]
    x.XFlush.argtypes=[ctypes.c_void_p]
    x.XCloseDisplay.argtypes=[ctypes.c_void_p]
    display=x.XOpenDisplay(None)
    if not display: raise RuntimeError('Desktop display unavailable')
    try:
        for line in windows:
            fields=line.split(None,5)
            if len(fields)<5: continue
            if fields[3].lower() in ('steamwebhelper.steam','steam.steam') or fields[3].lower().startswith('steam_app_') or int(fields[2]) in pids:
                x.XIconifyWindow(display,int(fields[0],16),0)
        x.XFlush(display)
    finally: x.XCloseDisplay(display)
if __name__=='__main__': main()
