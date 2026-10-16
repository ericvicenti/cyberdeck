"""Read-only visual regression for stale native cards. Requires running Casework on macOS."""
import pathlib, subprocess, tempfile, time
from smoke import action, call, choose
here = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='casework-visual-') as directory:
    directory = pathlib.Path(directory)
    helper = directory/'visual-text'
    subprocess.run(['swiftc',str(here/'visual-text.swift'),'-o',str(helper)], check=True)
    def check(expected):
        time.sleep(1)
        snapshot=directory/'screen.png';snapshot.write_bytes(call('/snapshot',raw=True))
        text=subprocess.check_output([str(helper),str(snapshot)],text=True)
        normalized=' '.join(text.lower().split())
        for label in expected:
            assert label.lower() in normalized, ('Rendered content mismatch',label,text,call())
    action('home');check(['Casework','Afterglow','Games','Cyberdeck'])
    action('right');assert call()['focused']=='Games'
    action('select');check(['Ready to play','Fleet library','Browse consoles'])
    action('back');choose('Afterglow')
    check(['Afterglow','Ready to watch','Discover films'])
    choose('Library');check(['Library','Ready to watch'])
    choose('Films');choose('Interstellar');check(['Interstellar','Watch','Save to my list'])
    action('back');choose('Series');choose('Breaking Bad');check(['Breaking Bad','Season 1'])
    choose('Season 1');check(['Season 1','Pilot'])
    action('home');choose('Afterglow')
    print('PASS rendered native cards / cinema shelves / film and series details')
