export class TaskRefCounter {
    count = 0;
    held = false;
    driver;
    constructor(driver){
        this.driver = driver;
    }
    get activeTasks() {
        return this.count;
    }
    get powerHeld() {
        return this.held;
    }
    taskStarted() {
        this.count += 1;
        if (!this.held) {
            this.held = this.driver.acquirePower();
        }
        return this.held;
    }
    taskEnded() {
        if (this.count > 0) this.count -= 1;
        if (this.count === 0 && this.held) {
            this.driver.releasePower();
            this.held = false;
        }
        return this.held;
    }
    reset() {
        this.count = 0;
        if (this.held) {
            this.driver.releasePower();
            this.held = false;
        }
    }
}
export function deriveState(args) {
    if (!args.enabled) return 'disabled';
    if (args.hasError && !args.powerHeld && args.activeTasks > 0) return 'error';
    if (!args.networkOnline) return 'network-interrupted';
    if (args.activeTasks > 0) return args.powerHeld ? 'active' : 'error';
    return 'enabled-idle';
}
