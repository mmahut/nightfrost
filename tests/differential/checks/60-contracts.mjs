// Contracts: record, latest state, balances, and action history for a sample
// of contracts from the nightfrost /contracts list (first, last, random).
// Actions are verified against oracle contractAction(address, offset) at each
// action's transaction.

export const name = 'contracts';

const TYPE = { ContractDeploy: 'deploy', ContractCall: 'call', ContractUpdate: 'update' };
const ACTIONS_CAP = 25;

export async function run(ctx, t) {
  const contracts = await ctx.nfAllPages('/contracts');
  t.note(`nightfrost lists ${contracts.length} contracts; oracle has no contract enumeration — sampled records verified individually`);

  const picks = new Set();
  if (contracts.length) {
    picks.add(0);
    picks.add(contracts.length - 1);
    while (picks.size < Math.min(ctx.cfg.contracts, contracts.length))
      picks.add(Math.floor(ctx.rand() * contracts.length));
  }

  for (const i of picks) {
    const addr = contracts[i].address;
    const [nfC, nfState, nfActions] = await Promise.all([
      ctx.nf(`/contracts/${addr}`),
      ctx.nf(`/contracts/${addr}/state`),
      ctx.nfAllPages(`/contracts/${addr}/actions`),
    ]);

    let data = null;
    try {
      data = await ctx.gql(`{
        contract(address:"${addr}") { address state }
        contractAction(address:"${addr}") {
          __typename state
          unshieldedBalances { tokenType amount }
          transaction { hash block { height } }
        }
      }`);
    } catch (e) {
      t.note(`oracle error on contract ${addr}: ${String(e.message).slice(0, 200)}`);
    }
    t.bump();
    if (!data?.contract) {
      t.mismatch(addr, 'existence', 'present', 'MISSING (oracle)');
      continue;
    }
    t.eq(addr, 'address', nfC.address, data.contract.address);
    t.eq(addr, 'latest state', nfState.state, data.contract.state);

    const la = data.contractAction;
    if (la) {
      t.eq(addr, 'latest action type', nfC.latest_action_type, TYPE[la.__typename] ?? la.__typename);
      t.eq(addr, 'latest block height', nfC.latest_block_height, la.transaction.block.height);
      const lastNf = nfActions[nfActions.length - 1];
      t.eq(addr, 'latest action tx', lastNf?.tx_hash ?? null, la.transaction.hash);
      const orBal = (la.unshieldedBalances ?? []).map((b) => [b.tokenType.toLowerCase(), String(b.amount)]).sort();
      const nfBal = (nfC.balances ?? []).map((b) => [b.token_type.toLowerCase(), String(b.amount)]).sort();
      t.eq(addr, 'balances', nfBal, orBal);
    }

    // action history sample: first 5, last 5, random middle, capped
    const sample =
      nfActions.length > ACTIONS_CAP
        ? [
            ...nfActions.slice(0, 5),
            ...nfActions.slice(-5),
            ...Array.from({ length: ACTIONS_CAP - 10 }, () => nfActions[Math.floor(ctx.rand() * nfActions.length)]),
          ]
        : nfActions;
    const seen = new Set();
    for (const a of sample) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      let d = null;
      try {
        d = await ctx.gql(`{ contractAction(address:"${addr}", offset:{transactionOffset:{hash:"${a.tx_hash}"}}) {
          __typename transaction { hash block { height } } ... on ContractCall { entryPoint } } }`);
      } catch { /* recorded below as missing */ }
      t.bump();
      const oa = d?.contractAction;
      if (!oa) {
        t.mismatch(`${addr} action ${a.id}`, 'existence', JSON.stringify(a), 'MISSING (oracle)');
        continue;
      }
      t.eq(`${addr} action ${a.id}`, 'type', a.type, TYPE[oa.__typename] ?? oa.__typename);
      t.eq(`${addr} action ${a.id}`, 'tx_hash', a.tx_hash, oa.transaction.hash);
      t.eq(`${addr} action ${a.id}`, 'block_height', a.block_height, oa.transaction.block.height);
      if (oa.__typename === 'ContractCall')
        t.eq(`${addr} action ${a.id}`, 'entry_point', a.entry_point, oa.entryPoint);
    }
    process.stderr.write(`contract ${addr.slice(0, 12)}...: ${nfActions.length} actions\n`);
  }
}
