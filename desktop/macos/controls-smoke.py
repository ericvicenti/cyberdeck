"""Native event-loop text handoff and player controls. Run only with --verify."""
import pathlib,time
from smoke import action,call,choose,settle
assert call()['verification'], 'Launch Casework with --verify to preserve viewing history'
action('home');choose('Afterglow');choose('Search');action('select')
assert call()['keyboard']=='A' and call()['onscreenKeyboard']
call('/test-key',{'key':'b','code':11});time.sleep(.5)
s=call();assert s['inputMode']=='keyboard' and not s['onscreenKeyboard'] and s['keyboard']=='Ab',s
call('/test-key',{'key':'c','code':8});time.sleep(.3)
s=call();assert s['keyboard']=='Abc',s
call('/input',{'action':'noop','source':'pointer'});assert not call()['onscreenKeyboard']
call('/input',{'action':'noop','source':'controller'});assert call()['onscreenKeyboard'] and call()['keyboard']=='Abc'
action('back');choose('Library');choose('In Bruges')
for _ in range(90):
 s=call()
 if s.get('player',{}).get('decodedFrames',0)>2:break
 time.sleep(.5)
assert s['player']['decodedFrames']>2,s
call('/input',{'action':'pause','source':'keyboard'});time.sleep(.5)
assert call()['player']['rate']==0
out=pathlib.Path.home()/'Library/Application Support/Casework'
(out/'qa-player-keyboard.png').write_bytes(call('/snapshot',raw=True))
action('up');assert call()['player']['controlSelection']==2
action('right');assert call()['player']['controlSelection']==3
before=call()['player']['originalTime'];action('select');settle();time.sleep(1)
assert call()['player']['originalTime']>=before+8
(out/'qa-player-controller.png').write_bytes(call('/snapshot',raw=True))
action('menu');assert call()['player']['menu'];action('back');assert not call()['player']['menu']
call('/input',{'action':'pause','source':'keyboard'});time.sleep(5)
assert not call()['player']['controlsVisible'],call()
call('/input',{'action':'noop','source':'pointer'});assert call()['player']['controlsVisible']
action('home');choose('Afterglow')
print('PASS native physical-key event handoff / preserved text / controller restoration / transport focus and seek / auto-hide / pointer wake')
