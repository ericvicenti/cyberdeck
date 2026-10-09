export type Point = { x: number; y: number };
export type DriftState = { player: Point; velocity: Point; target: Point; score: number; hits: number; time: number; flash: number; cooldown: number };
export const createDrift = (): DriftState => ({ player: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, target: { x: 0.38, y: 0.18 }, score: 0, hits: 0, time: 0, flash: 0, cooldown: 0 });
export function hazardsAt(time: number): Point[] {
  return [{ x: Math.sin(time * 0.43) * 0.64, y: Math.cos(time * 0.57) * 0.65 }, { x: Math.cos(time * 0.37 + 1) * 0.72, y: Math.sin(time * 0.49 + 2) * 0.61 }];
}
export function steer(x: number, y: number): Point {
  const length = Math.max(1, Math.hypot(x, y));
  return { x: x / length, y: y / length };
}
export function advanceDrift(state: DriftState, input: Point, seconds: number, aspect: number) {
  const dt = Math.max(0, Math.min(seconds, 0.04));
  const direction = steer(input.x, input.y);
  state.time += dt; state.flash = Math.max(0, state.flash - dt * 1.8); state.cooldown = Math.max(0, state.cooldown - dt);
  const blend = 1 - Math.exp(-dt * 9);
  state.velocity.x += (direction.x * 0.8 - state.velocity.x) * blend;
  state.velocity.y += (direction.y * 0.8 - state.velocity.y) * blend;
  const edge = Math.max(0.12, aspect - 0.08);
  state.player.x = Math.max(-edge, Math.min(edge, state.player.x + state.velocity.x * dt));
  state.player.y = Math.max(-0.9, Math.min(0.9, state.player.y + state.velocity.y * dt));
  state.target.x = Math.max(-edge, Math.min(edge, state.target.x));
  let event: 'collected' | 'hit' | undefined;
  if (Math.hypot(state.player.x - state.target.x, state.player.y - state.target.y) < 0.11) {
    state.score += 1; state.flash = 1; event = 'collected';
    const angle = state.score * 2.39996;
    const radius = 0.48 + (state.score % 3) * 0.1;
    state.target = { x: Math.cos(angle) * Math.min(edge * 0.78, 0.78), y: Math.sin(angle) * radius };
  }
  if (!state.cooldown && hazardsAt(state.time).some(h => Math.hypot(state.player.x - h.x, state.player.y - h.y) < 0.125)) {
    state.hits += 1; state.cooldown = 1.5; state.flash = 0; event = 'hit';
  }
  return event;
}
