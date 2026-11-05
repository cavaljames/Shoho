import { shoho } from './bridge';
import type { Snapshot } from './types';
const choices = document.querySelector<HTMLElement>('#reminder-presets')!;
const drink = document.querySelector<HTMLButtonElement>('#reminder-drink')!;
const message = document.querySelector<HTMLElement>('#reminder-error')!;
let state: Snapshot, selected = '';
async function act(callback: () => Promise<unknown>) { try { await callback(); } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); } }
function updateSelection() {
  choices.querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === selected)));
  const preset = state.settings.presets.find(preset => preset.id === selected);
  drink.textContent = `记录 ＋${preset?.amount || 0} ml`;
}
function render(next: Snapshot) {
  state = next; choices.replaceChildren();
  if (!state.settings.presets.some(preset => preset.id === selected)) selected = state.settings.defaultPresetId;
  choices.style.gridTemplateColumns = `repeat(${Math.min(3, state.settings.presets.length)}, minmax(0, 1fr))`;
  for (const preset of state.settings.presets) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'reminder-option'; button.dataset.id = preset.id;
    button.setAttribute('aria-label', `选择${preset.name} ${preset.amount} ml`); button.title = `${preset.name} · ${preset.amount} ml`;
    const name = document.createElement('span'); name.textContent = preset.name;
    const amount = document.createElement('small'); amount.textContent = `${preset.amount} ml`;
    button.append(name, amount); button.addEventListener('click', () => { selected = preset.id; updateSelection(); }); choices.append(button);
  }
  updateSelection();
}
act(async () => { await shoho.onState(render); render(await shoho.getState()); document.querySelector<HTMLElement>('#reminder-title')!.focus({ preventScroll: true }); await shoho.ready(); });
drink.addEventListener('click', () => act(async () => { drink.disabled = true; try { await shoho.drinkPreset(selected); } finally { drink.disabled = false; } }));
document.querySelector('#snooze')!.addEventListener('click', () => act(() => shoho.pause(10)));
document.querySelector('#dismiss')!.addEventListener('click', () => act(() => shoho.dismiss()));
