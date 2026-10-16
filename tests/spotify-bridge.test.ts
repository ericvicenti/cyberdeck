import { test, expect } from 'bun:test';
import { spotifyBridgeRequest } from '../ui/lib/spotify-bridge';
test('Spotify bridge permits catalog reads and explicit playback controls only', () => {
  for (const path of ['/me','/me/playlists?limit=50','/search?q=hello&type=track','/albums/abc123/tracks','/me/player/devices']) expect(spotifyBridgeRequest({path}).method).toBe('GET');
  expect(spotifyBridgeRequest({path:'/me/player/play?device_id=abc',method:'PUT',body:{uris:['spotify:track:abc']}}).method).toBe('PUT');
  expect(spotifyBridgeRequest({path:'/me/player/next',method:'POST'}).method).toBe('POST');
  for (const path of ['//evil.test/me','https://evil.test/me','/me/../tokens','/me#x','/albums/abc%2ftracks','/me\\player','/me/player/../../api/token']) expect(() => spotifyBridgeRequest({path})).toThrow();
  for (const [path,method] of [['/me/tracks','PUT'],['/playlists/abc/tracks','POST'],['/me/player','DELETE'],['/me/playlists','POST']]) expect(() => spotifyBridgeRequest({path,method})).toThrow();
});
