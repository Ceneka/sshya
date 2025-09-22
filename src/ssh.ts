import { ChildProcess, spawn } from 'child_process';
import type { Connection } from './database';
import { recordConnectionUsage } from './database';

// Track the currently running SSH child-process so other parts of the program
// (e.g. the global key-handler) can know whether we are inside an SSH session.
let currentSshProcess: ChildProcess | null = null;

export function isSshSessionActive(): boolean {
    return currentSshProcess !== null;
}

export function buildSSHArgs(connection: Connection) {
    const args = [];
    if (connection.key_path) args.push('-i', connection.key_path);
    if (connection.port) args.push('-p', connection.port);
    args.push(`${connection.user}@${connection.host}`);
    return args;
}

export function runSSH(alias: string, connection: Connection) {
    recordConnectionUsage(alias);
    const args = buildSSHArgs(connection);

    const sshProcess = spawn('ssh', args, {
        stdio: 'pipe', // Full control over stdio
    });

    // Mark session active so that other modules can detect we are now inside an
    // SSH session.
    currentSshProcess = sshProcess;

    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.pipe(sshProcess.stdin);
    sshProcess.stdout.pipe(process.stdout);
    sshProcess.stderr.pipe(process.stderr);

    const onResize = () => {
        if (sshProcess.pid) {
            try {
                process.kill(sshProcess.pid, 'SIGWINCH');
            } catch {
                /* Process already exited – ignore */
            }
        }
    };

    const cleanup = (code?: number | null) => {
        if (process.stdout.isTTY) {
            process.stdout.removeListener('resize', onResize);
        }
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.unpipe(sshProcess.stdin);
        // Mark session ended
        currentSshProcess = null;
        process.exit(code ?? 0);
    };

    if (process.stdout.isTTY) {
        process.stdout.on('resize', onResize);
        onResize();
    }

    sshProcess.on('exit', cleanup);
    sshProcess.on('error', () => cleanup(1));
} 
