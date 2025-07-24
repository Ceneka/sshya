import readline from 'readline';
import { isSshSessionActive } from '../ssh';

/**
 * Enable global Escape key handler that terminates the CLI gracefully.
 * Call the returned cleanup function after finishing the prompt to restore terminal state.
 */
export function enableEscapeExit(): () => void {
    // Ensure keypress events are emitted
    readline.emitKeypressEvents(process.stdin);

    // If the terminal is interactive, switch to raw mode so we can capture individual keys
    const shouldRestoreRawMode = process.stdin.isTTY && !process.stdin.isRaw;
    if (shouldRestoreRawMode) {
        process.stdin.setRawMode(true);
    }

    const onKeypress = (_: string, key: readline.Key) => {
        // Handle ESC key – ignored while an SSH session is active so that
        // pressing Escape inside the remote shell works as expected.
        if (key.name === 'escape') {
            if (isSshSessionActive()) {
                return; // let the remote shell receive the key
            }
            console.log('\nCancelled by user.');
            process.exit(0);
        }

        // Handle Ctrl+C. When stdin is in raw mode (which we enable above), the
        // usual SIGINT event is **not** emitted. However, we still respect a
        // running SSH session: users can terminate the remote session with
        // their usual shortcut inside the SSH client, so we don’t force-exit
        // the parent app in that case.
        if (key.ctrl && key.name === 'c') {
            if (isSshSessionActive()) {
                return; // let ssh handle the interrupt
            }
            console.log('\nCancelled by user.');
            process.exit(0);
        }
    };

    process.stdin.on('keypress', onKeypress);

    // Return a cleanup fn to detach listener & restore terminal
    return () => {
        process.stdin.off('keypress', onKeypress);
        if (shouldRestoreRawMode && process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    };
} 
