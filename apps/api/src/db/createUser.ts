/**
 * Create or update a user from the command line.
 *
 *   npm run create-admin -- --email you@example.com --name "Jamal" --password '...'
 *   npm run create-user  -- --email cust@example.com --name "Customer" --role customer
 *
 * Omit --password to be prompted (input is hidden). Re-running for an existing
 * email updates that user's password/role rather than failing, so it doubles as
 * a password reset.
 *
 * The first admin created also adopts any pre-auth rows that have no owner.
 */

import readline from 'readline';
import { pool, query } from './index';
import { hashPassword, checkPasswordPolicy } from '../services/password';

interface Args {
  email?: string;
  name?: string;
  password?: string;
  role: 'admin' | 'customer';
}

function parseArgs(argv: string[]): Args {
  const out: Args = { role: 'admin' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    const consume = () => { if (inline === undefined) i++; };
    switch (flag) {
      case '--email': out.email = value; consume(); break;
      case '--name': out.name = value; consume(); break;
      case '--password': out.password = value; consume(); break;
      case '--role':
        if (value !== 'admin' && value !== 'customer') {
          throw new Error(`--role must be admin or customer, got "${value}"`);
        }
        out.role = value; consume(); break;
      default: break;
    }
  }
  return out;
}

function promptHidden(questionText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    stdout.muted = false;

    // Suppress echo so the password does not land in the terminal scrollback.
    const originalWrite = stdout.write.bind(stdout);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (stdout.muted) originalWrite('');
      else originalWrite(s);
    };

    rl.question(questionText, (answer) => {
      stdout.muted = false;
      originalWrite('\n');
      rl.close();
      resolve(answer);
    });
    stdout.muted = true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) throw new Error('--email is required');
  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${email}" is not a valid email`);

  const name = args.name?.trim() || email.split('@')[0];

  let password = args.password ?? process.env.INITIAL_ADMIN_PASSWORD;
  if (!password) password = await promptHidden(`Password for ${email}: `);

  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.reason);

  const passwordHash = await hashPassword(password);

  const existing = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = $1', [email]);

  let userId: string;
  if (existing.rowCount! > 0) {
    userId = existing.rows[0].id;
    await query(
      `UPDATE users
       SET name = $2, role = $3, password_hash = $4, is_active = true,
           failed_login_count = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId, name, args.role, passwordHash]
    );
    // A password reset must not leave old sessions alive.
    await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    console.log(`Updated existing user ${email} (role: ${args.role}). Existing sessions revoked.`);
  } else {
    const r = await query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [email, name, args.role, passwordHash]
    );
    userId = r.rows[0].id;
    console.log(`Created ${args.role} ${email}`);
  }

  if (args.role === 'admin') {
    const accounts = await query('UPDATE broker_accounts SET user_id = $1 WHERE user_id IS NULL', [userId]);
    const strategies = await query('UPDATE strategies SET user_id = $1 WHERE user_id IS NULL', [userId]);
    if (accounts.rowCount || strategies.rowCount) {
      console.log(
        `Adopted ${accounts.rowCount ?? 0} unowned account(s) and ${strategies.rowCount ?? 0} strategy(ies).`
      );
    }
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
    await pool.end();
    process.exit(1);
  });
