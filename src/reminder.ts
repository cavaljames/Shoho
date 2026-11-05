import { shoho } from './bridge';
let cup = 200;
const drink = document.querySelector<HTMLButtonElement>('#reminder-drink')!;
const message = document.querySelector<HTMLElement>('#reminder-error')!;
async function act(callback: () => Promise<unknown>) { try { await callback(); } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); } }
act(async () => { const state = await shoho.getState(); cup = state.settings.cup; drink.textContent = `喝了一杯 · ${cup} ml`; await shoho.ready(); });
drink.addEventListener('click', () => act(async () => { drink.disabled = true; try { await shoho.drink(cup); } finally { drink.disabled = false; } }));
document.querySelector('#snooze')!.addEventListener('click', () => act(() => shoho.pause(10)));
document.querySelector('#dismiss')!.addEventListener('click', () => act(() => shoho.dismiss()));
