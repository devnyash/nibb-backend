const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet } = require('@coral-xyz/anchor');
const fs = require('fs');

class SolanaService {
  constructor() {
    this.connection = null;
    this.program = null;
    this.authority = null;
    this.isSimulated = true;

    this.init();
  }

  init() {
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, 'confirmed');

      const programId = process.env.PROGRAM_ID;
      const idlPath = process.env.IDL_PATH;
      const authorityKey = process.env.AUTHORITY_KEYPAIR;

      if (!programId || !idlPath || !authorityKey) {
        console.warn('SolanaService: Missing config (PROGRAM_ID, IDL_PATH or AUTHORITY_KEYPAIR). Running in SIMULATION mode.');
        return;
      }

      // Load IDL
      const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
      
      // Load Authority Keypair
      const keypairBuffer = Uint8Array.from(JSON.parse(authorityKey));
      this.authority = Keypair.fromSecretKey(keypairBuffer);

      // Anchor Provider
      const wallet = new Wallet(this.authority);
      const provider = new AnchorProvider(this.connection, wallet, {
        preflightCommitment: 'confirmed',
      });

      this.program = new Program(idl, new PublicKey(programId), provider);
      this.isSimulated = false;
      console.log('SolanaService: Initialized successfully in REAL mode.');
    } catch (e) {
      console.error('SolanaService: Init failed:', e.message);
      this.isSimulated = true;
    }
  }

  async _execute(method, args) {
    if (this.isSimulated) {
      console.log(`[SIMULATION] Calling ${method} with`, args);
      return { ok: true, tx: 'sim_tx_' + Math.random().toString(36).substring(7) };
    }

    try {
      // Use Anchor program to call the method
      const txid = await this.program.methods[method](...args).rpc();
      return { ok: true, tx: txid };
    } catch (e) {
      console.error(`SolanaService: ${method} failed:`, e);
      throw e;
    }
  }

  async reserve(wallet, amountUsd) {
    // Example: reserve(user_wallet, amount)
    return this._execute('reserve', [new PublicKey(wallet), amountUsd]);
  }

  async payout(wallet, amountUsd) {
    // Example: payout(user_wallet, amount)
    return this._execute('payout', [new PublicKey(wallet), amountUsd]);
  }

  async buyback(wallet, amountUsd) {
    // Example: buyback(user_wallet, amount)
    return this._execute('buyback', [new PublicKey(wallet), amountUsd]);
  }

  async deposit(wallet, amountUsd) {
    // Example: deposit(user_wallet, amount)
    return this._execute('deposit', [new PublicKey(wallet), amountUsd]);
  }
}

module.exports = new SolanaService();
