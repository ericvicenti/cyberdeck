"""Exercise the running native app through its controller input reducer; no GUI permission needed."""
import json, pathlib, time, urllib.request
root = pathlib.Path.home()
token = (root / '.cyberdeck/token').read_text().strip()
def call(path='/state', body=None, raw=False):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request('http://127.0.0.1:4778'+path, data=data, headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response: value = response.read()
    return value if raw else json.loads(value)
def action(name): return call('/input', {'action': name})
def settle():
    deadline = time.monotonic()+95
    while time.monotonic()<deadline:
        state = call()
        if not state['busy']: return state
        time.sleep(.2)
    raise AssertionError('Operation timed out')
def choose(label):
    state = settle(); assert label in state['tiles'], (label, state)
    target = state['tiles'].index(label)
    for _ in range(200):
        if state['selection'] == target: break
        rows = state.get('shelves', [])
        if rows:
            source_row = next(i for i,r in enumerate(rows) if r['start'] <= state['selection'] < r['start']+r['count'])
            target_row = next(i for i,r in enumerate(rows) if r['start'] <= target < r['start']+r['count'])
            if source_row != target_row:
                state = action('down' if source_row < target_row else 'up'); continue
        state = action('right' if state['selection'] < target else 'left')
    else: raise AssertionError(('Could not focus',label,state))
    action('select'); return settle()
def check(name, state):
    assert not state['message'], (name, state['message'])
    print(name, state['title'], len(state['tiles']), flush=True)
if __name__ == '__main__':
    action('home'); state=call(); assert state['fullscreen']; assert state['controlConnected']
    check('home',state)
    choose('Afterglow'); assert call()['cinema']; check('library',choose('Library')); assert call()['tiles']
    action('back'); check('films',choose('Films')); assert len(call()['tiles']) > 6
    action('back'); choose('Search')
    assert call()['keyboard']==''
    action('select'); assert call()['keyboard']=='A'
    action('back'); assert call()['keyboard'] is None
    action('home'); choose('Games'); check('fleet-games',choose('Fleet library'))
    action('home'); choose('Cyberdeck'); check('machines',choose('Machines'))
    action('home')
    try:
        urllib.request.urlopen('http://127.0.0.1:4778/state')
        raise AssertionError('Control endpoint accepted an unauthenticated request')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    request = urllib.request.Request('http://127.0.0.1:4777/api/state', headers={'Authorization':'Bearer '+token})
    devices = json.load(urllib.request.urlopen(request))['devices']
    device = next(d for d in devices if d.get('info',{}).get('name') == 'Clipper · Casework Native')
    command = {'deviceId':device['id'], 'action':{'name':'casework.input','args':{'action':'right'}}}
    request = urllib.request.Request('http://127.0.0.1:4777/api/command', data=json.dumps(command).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    result = json.load(urllib.request.urlopen(request)); assert result['sent'] == 1, result
    time.sleep(.2); assert call()['focused'] == 'Games'
    action('home')
    out=root/'Library/Application Support/Casework/qa-home.png';out.write_bytes(call('/snapshot',raw=True))
    print('PASS native navigation / read-only live services / keyboard / fullscreen')
