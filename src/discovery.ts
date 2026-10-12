import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as osc from 'osc-min';
import type { EtcDiscoveredDevice } from 'eos-console';

const DISCOVERY_PORT = 3034;
const DISCOVERY_INTERVAL = 1000;
const EXPIRE_TIMEOUT = 5000;
const SERVICE_NAME = 'CueNote';
const LIMITED_BROADCAST = '255.255.255.255';

interface SocketEntry {
    socket: dgram.Socket;
    bound: boolean;
}

/**
 * ETC device discovery that works with mixed subnet masks.
 *
 * eos-console's EtcDiscovery only sends to each interface's directed broadcast
 * address (e.g. 10.101.255.255 for a /16). A device with a wider mask (e.g.
 * /8) does not treat that as a broadcast and never replies. To reach every
 * device, the request is also sent to the limited broadcast address
 * (255.255.255.255) from a socket bound to each interface.
 *
 * Emits 'changed' whenever a device is found or lost.
 */
export class EtcDeviceDiscovery extends EventEmitter {
    private devices = new Map<string, EtcDiscoveredDevice>();
    private lastSeen = new Map<string, number>();
    private sockets = new Map<string, SocketEntry>();
    private timer: NodeJS.Timeout | null = null;

    start() {
        if (this.timer) {
            return;
        }

        this.discover();
        this.timer = setInterval(() => this.discover(), DISCOVERY_INTERVAL);
    }

    stop() {
        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;

        for (const address of [...this.sockets.keys()]) {
            this.closeSocket(address);
        }

        this.devices.clear();
        this.lastSeen.clear();
    }

    getDevices(): EtcDiscoveredDevice[] {
        return Array.from(this.devices.values());
    }

    private discover() {
        this.deleteExpiredDevices();

        const targets = new Map<string, string[]>();

        for (const addrs of Object.values(os.networkInterfaces())) {
            for (const iface of addrs ?? []) {
                if (iface.internal || iface.family !== 'IPv4') {
                    continue;
                }

                targets.set(iface.address, [
                    LIMITED_BROADCAST,
                    directedBroadcast(iface.address, iface.netmask),
                ]);
            }
        }

        // Drop sockets for interfaces that have disappeared
        for (const address of this.sockets.keys()) {
            if (!targets.has(address)) {
                this.closeSocket(address);
            }
        }

        for (const [address, destinations] of targets) {
            this.sendRequest(address, destinations);
        }
    }

    private sendRequest(address: string, destinations: string[]) {
        const entry = this.sockets.get(address) ?? this.openSocket(address);

        // The socket may still be binding; it is picked up on the next tick
        if (!entry.bound) {
            return;
        }

        const request = osc.toBuffer({
            address: '/etc/discovery/request',
            args: [
                { type: 'integer', value: entry.socket.address().port },
                { type: 'string', value: SERVICE_NAME },
            ],
        });

        for (const destination of destinations) {
            entry.socket.send(request, DISCOVERY_PORT, destination, () => {
                // Delivery failures (e.g. an interface going down) are expected
            });
        }
    }

    private openSocket(address: string): SocketEntry {
        const socket = dgram.createSocket('udp4');
        const entry: SocketEntry = { socket, bound: false };

        socket.on('message', (data, info) => this.handleReply(data, info));
        socket.on('error', () => this.closeSocket(address));
        socket.bind({ address, port: 0 }, () => {
            socket.setBroadcast(true);
            entry.bound = true;
        });

        this.sockets.set(address, entry);

        return entry;
    }

    private closeSocket(address: string) {
        const entry = this.sockets.get(address);

        if (!entry) {
            return;
        }

        this.sockets.delete(address);
        entry.socket.removeAllListeners();
        entry.socket.on('error', () => undefined);

        try {
            entry.socket.close();
        } catch {
            // Already closed
        }
    }

    private handleReply(data: Buffer, info: dgram.RemoteInfo) {
        let device: EtcDiscoveredDevice;

        try {
            const message = osc.fromBuffer(data);

            if (message.oscType !== 'message' || message.args.length < 4) {
                return;
            }

            const [port, name, uid, version] = message.args.map(
                (arg) => arg.value,
            );

            device = {
                host: info.address,
                name: String(name),
                port: Number(port),
                // Eos wraps the UID in braces
                uid: String(uid).replace(/^\{|\}$/g, ''),
                version: String(version),
            };
        } catch {
            return;
        }

        const key = `${device.uid}_${device.host}_${device.port}`;
        const isNewDevice = !this.devices.has(key);

        this.devices.set(key, device);
        this.lastSeen.set(key, Date.now());

        if (isNewDevice) {
            this.emit('changed');
        }
    }

    private deleteExpiredDevices() {
        const now = Date.now();
        let changed = false;

        for (const [key, lastSeen] of this.lastSeen) {
            if (now - lastSeen > EXPIRE_TIMEOUT) {
                this.devices.delete(key);
                this.lastSeen.delete(key);
                changed = true;
            }
        }

        if (changed) {
            this.emit('changed');
        }
    }
}

function directedBroadcast(address: string, netmask: string) {
    const addr = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);

    return addr.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.');
}
