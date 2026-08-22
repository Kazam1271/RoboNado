/**
 * Talk to RoboNado.
 *
 *   npm run chat                 read-only unless NADO_PRIVATE_KEY is set
 *   npm run chat -- --read-only  force read-only even with a key present
 *
 * Needs ANTHROPIC_API_KEY. Orders are never sent without an explicit `confirm`
 * typed here — the model cannot approve its own proposals.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { privateKeyToAccount } from 'viem/accounts';

import { Copilot } from '../src/agent.ts';
import { NadoGateway } from '../src/gateway.ts';
import { describePolicy } from '../src/policy.ts';

const NETWORK = 'testnet' as const;
const readOnly = process.argv.includes('--read-only');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env and rerun.');
  process.exit(1);
}

const key = readOnly ? undefined : process.env.NADO_PRIVATE_KEY;
const account = key ? privateKeyToAccount(key as `0x${string}`) : undefined;
const address = (account?.address ?? process.env.NADO_ADDRESS) as `0x${string}` | undefined;

if (!address) {
  console.error('Set NADO_PRIVATE_KEY, or NADO_ADDRESS for a read-only session.');
  process.exit(1);
}

const copilot = new Copilot({
  network: NETWORK,
  gateway: new NadoGateway(NETWORK),
  address,
  account,
  builderId: Number(process.env.ROBONADO_BUILDER_ID ?? 0),
});

console.log('RoboNado — commodity, FX and equity perps on Nado');
console.log(`network ${NETWORK}   wallet ${address}`);
console.log(account ? 'trading enabled (orders still need your confirmation)' : 'read-only');
console.log(`\n${describePolicy()}\n`);
console.log('Ask anything. "confirm <token>" approves a prepared order. Ctrl+C to exit.\n');

const rl = createInterface({ input: stdin, output: stdout });

for (;;) {
  let input: string;
  try {
    input = (await rl.question('> ')).trim();
  } catch {
    // stdin closed — piped input ran out, or Ctrl+D. Not an error.
    break;
  }
  if (!input) continue;
  if (input === 'exit' || input === 'quit') break;

  // Confirmation is handled here, outside the model loop, so approving an
  // order is always a human action.
  if (input.startsWith('confirm ')) {
    const token = input.slice('confirm '.length).trim();
    console.log(`\n${await copilot.confirm(token)}\n`);
    continue;
  }

  try {
    const reply = await copilot.ask(input);
    console.log(`\n${reply}\n`);
  } catch (err) {
    console.error(`\nerror: ${(err as Error).message}\n`);
  }
}

rl.close();
