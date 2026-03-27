import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

const app = express();
app.use(cors());
app.use(express.json());

// ─── Setup Sui Client ───
const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

// ─── Load Admin Keypair ───
const { secretKey } = decodeSuiPrivateKey(process.env.ADMIN_PRIVATE_KEY);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

// ─── Contract IDs ───
const PACKAGE_ID = process.env.PACKAGE_ID;
const ADMIN_CAP_ID = process.env.ADMIN_CAP_ID;
const REGISTRY_ID = process.env.REGISTRY_ID;
const CLOCK_ID = process.env.CLOCK_ID;

// ─── Helper: Check if already registered ───
async function isAlreadyRegistered(walletAddress) {
    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${PACKAGE_ID}::agent::is_registered`,
            arguments: [
                tx.object(REGISTRY_ID),
                tx.pure.address(walletAddress),
            ],
        });
        const result = await client.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: walletAddress,
        });
        const returnVal = result?.results?.[0]?.returnValues?.[0];
        if (returnVal) return returnVal[0][0] === 1;
        return false;
    } catch (e) {
        return false;
    }
}

// ─── Helper: Validate Sui address ───
function isValidSuiAddress(address) {
    return /^0x[a-fA-F0-9]{64}$/.test(address);
}

// ─── ROUTE: Health check ───
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: '$AGENT Badge Registration API',
        network: 'sui-mainnet'
    });
});

// ─── ROUTE: Register Agent ───
app.post('/register', async (req, res) => {
    try {
        const { wallet, skillHash } = req.body;

        if (!wallet || !isValidSuiAddress(wallet)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Sui wallet address.'
            });
        }

        const already = await isAlreadyRegistered(wallet);
        if (already) {
            return res.status(400).json({
                success: false,
                error: 'This wallet is already registered.'
            });
        }

        const skillHashBytes = skillHash
            ? Array.from(Buffer.from(skillHash, 'utf8'))
            : Array.from(Buffer.from('default-agent-skill', 'utf8'));

        const tx = new Transaction();
        tx.moveCall({
            target: `${PACKAGE_ID}::agent::register_agent`,
            arguments: [
                tx.object(REGISTRY_ID),
                tx.object(ADMIN_CAP_ID),
                tx.pure.address(wallet),
                tx.pure.vector('u8', skillHashBytes),
                tx.object(CLOCK_ID),
            ],
        });
        tx.setGasBudget(10000000);

        const result = await client.signAndExecuteTransaction({
            signer: keypair,
            transaction: tx,
            options: {
                showEffects: true,
                showObjectChanges: true,
            },
        });

        if (result.effects?.status?.status === 'success') {
            const badgeObj = result.objectChanges?.find(
                obj => obj.objectType?.includes('AgentBadge')
            );
            return res.json({
                success: true,
                message: 'AgentBadge successfully minted to your wallet!',
                txDigest: result.digest,
                badgeId: badgeObj?.objectId || null,
                wallet: wallet,
            });
        } else {
            return res.status(500).json({
                success: false,
                error: 'Transaction failed on-chain.',
                details: result.effects?.status?.error
            });
        }

    } catch (error) {
        console.error('Registration error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error.',
            details: error.message
        });
    }
});

// ─── ROUTE: Check registration status ───
app.get('/status/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        if (!isValidSuiAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }
        const registered = await isAlreadyRegistered(wallet);
        return res.json({
            wallet,
            registered,
            message: registered
                ? 'This wallet has an active AgentBadge'
                : 'This wallet is not registered'
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ─── START SERVER ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`$AGENT Badge API running on port ${PORT}`);
    console.log(`Admin wallet: ${keypair.toSuiAddress()}`);
});