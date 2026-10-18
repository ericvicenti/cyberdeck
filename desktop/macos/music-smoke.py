import time,pathlib,json,urllib.request
from smoke import call,action,choose,settle
assert call()['verification']
action('home');choose('Afterglow');choose('Music');s=settle();assert s['music'],s
assert 'Evening playlist' in s['tiles'] and 'Night drive' in s['tiles'],s
choose('Evening playlist');choose('Evening light');settle();assert call()['spotify']['is_playing']
action('pause');settle();assert not call()['spotify']['is_playing']
action('pause');settle();assert call()['spotify']['is_playing']
action('next');settle();action('previous');settle()
before=call()['spotify']['shuffle_state'];choose('Shuffle');settle();assert call()['spotify']['shuffle_state']!=before
before=call()['spotify']['repeat_state'];choose('Repeat');settle();assert call()['spotify']['repeat_state']!=before
before=call()['spotify']['device']['volume_percent'];choose('Volume +');settle();assert call()['spotify']['device']['volume_percent']==min(100,before+10)
choose('Devices');choose('Clipper fixture');assert call()['spotifyDevice']=='Clipper fixture'
action('search');call('/text',{'text':'evening'});# Done is last key
for _ in range(4):action('down')
for _ in range(7):action('right')
action('select');settle();assert call()['title']=='Search · evening',call()
call('/input',{'source':'keyboard','action':'noop'});assert call()['inputMode']=='keyboard'
call('/input',{'source':'pointer','action':'noop'});assert call()['inputMode']=='pointer'
call('/input',{'source':'controller','action':'noop'});assert call()['inputMode']=='controller'
root=pathlib.Path.home()/'Library/Application Support/Casework';(root/'qa-music.png').write_bytes(call('/snapshot',raw=True))
commands=json.load(urllib.request.urlopen('http://127.0.0.1:4779/commands'))['commands']
for suffix in ['/play','/pause','/next','/previous','/shuffle','/repeat','/volume']:
 assert any('/me/player'+suffix+'?' in c['path'] for c in commands),suffix
assert all(c.get('method','GET')=='GET' or 'device_id=clipper-test' in c['path'] for c in commands)
print('PASS native Spotify shelves / tracks / search / device choice / play-pause / previous-next / shuffle-repeat / volume / input switching; isolated provider fixture')
