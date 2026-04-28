import './server-only-shim.cjs';

async function main() {
  const chainArg = process.argv[2]?.trim().toLowerCase();
  const addressArg = process.argv[3]?.trim();
  const ownerNameArg = process.argv[4]?.trim();

  if (
    (chainArg !== 'bsc' && chainArg !== 'solana' && chainArg !== 'ethereum' && chainArg !== 'base') ||
    !addressArg ||
    !ownerNameArg
  ) {
    throw new Error('Usage: tsx scripts/repair-tracked-address-ownership.ts <chain> <address> <owner-name>');
  }

  const { listTrackedUsers, repairTrackedAddressOwnership } = await import('@/lib/server/trackedUsersRepo');

  const owner = listTrackedUsers().find(
    (user) =>
      user.name === ownerNameArg &&
      user.addresses.some((address) => address.chain === chainArg && address.address === addressArg)
  );

  if (!owner) {
    throw new Error(`Owner not found for ${ownerNameArg} ${chainArg}:${addressArg}`);
  }

  const result = repairTrackedAddressOwnership({
    chain: chainArg,
    address: addressArg,
    ownerUserId: owner.id,
  });

  console.log(JSON.stringify(result, null, 2));
}

void main();
