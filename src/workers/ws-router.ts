// noinspection JSUnusedGlobalSymbols

import {HyperionWorker} from "./hyperionWorker.js";

import {Server, Socket} from "socket.io";
import {checkFilter, hLog} from "../helpers/common_functions.js";
import {createServer} from "http";
import process from "node:process";
import {Message} from "amqplib";

const greylist = ['eosio.token'];

interface BaseLink {
    type: string;
    relay: string;
    client: any;
    filters: any;
    added_on: number;
}

interface ActionLink extends BaseLink {
    account: string;
}

interface DeltaLink extends BaseLink {
    payer: string;
}

export default class WSRouter extends HyperionWorker {

    q: string;
    totalRoutedMessages = 0;
    firstData = false;
    relays: Record<string, any> = {};
    clientIndex = new Map();
    codeActionMap: Map<string, any> = new Map();
    notifiedMap: Map<string, any> = new Map();
    codeDeltaMap = new Map();
    payerMap = new Map();
    activeRequests = new Map();
    private io!: Server;
    private totalClients = 0;

    constructor() {
        super();
        this.q = this.chain + ':stream';
        this.activeRequests.set('*', {
            sockets: []
        });
    }

    assertQueues(): void {
        this.ch.assertQueue(this.q);
        this.ch.consume(this.q, this.onConsume.bind(this));
    }


    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'lib_update': {
                this.io.emit('lib_update', {
                    chain_id: this.manager.conn.chains[this.chain]?.chain_id,
                    ...msg.data
                });
                break;
            }
            case 'fork_event': {
                this.io.emit('fork_event', {
                    chain_id: this.manager.conn.chains[this.chain]?.chain_id,
                    ...msg.data
                });
                break;
            }
        }
    }

    async run(): Promise<void> {
        this.initRoutingServer();
        this.startRoutingRateMonitor();
        return undefined;
    }

    onConsume(msg: Message | null) {

        if (msg === null) {
            return;
        }

        if (!this.firstData) {
            this.firstData = true;
        }

        // push to plugin handlers
        this.mLoader.processStreamEvent(msg);

        switch (msg.properties.headers.event) {
            case 'trace': {
                const actHeader = msg.properties.headers;
                const code = actHeader.account;
                const name = actHeader.name;
                const notified: string[] = actHeader.notified.split(',');
                let decodedMsg: string;

                // send to contract subscribers
                if (this.codeActionMap.has(code)) {
                    const codeReq = this.codeActionMap.get(code);
                    decodedMsg = Buffer.from(msg.content).toString();

                    // send to action subscribers
                    if (codeReq.has(name)) {
                        for (const link of codeReq.get(name).links) {
                            this.forwardActionMessage(decodedMsg, link, notified);
                        }
                    }
                    // send to wildcard subscribers
                    if (codeReq.has("*")) {
                        for (const link of codeReq.get("*").links) {
                            this.forwardActionMessage(decodedMsg, link, notified);
                        }
                    }
                }

                // send to notification subscribers
                notified.forEach((acct: string) => {
                    if (this.notifiedMap.has(acct)) {
                        if (!decodedMsg) {
                            decodedMsg = Buffer.from(msg.content).toString();
                        }
                        for (const link of this.notifiedMap.get(acct).links) {
                            this.forwardActionMessage(decodedMsg, link, notified);
                        }
                    }
                });
                break;
            }

            case 'delta': {
                const deltaHeader = msg.properties.headers;
                const code = deltaHeader.code;
                const table = deltaHeader.table;
                // const scope = deltaHeader.scope;
                const payer = deltaHeader.payer;
                // console.log(code, table, scope, payer);
                let decodedDeltaMsg;
                // Forward to CODE/TABLE listeners
                if (this.codeDeltaMap.has(code)) {
                    decodedDeltaMsg = Buffer.from(msg.content).toString();

                    const tableDeltaMap = this.codeDeltaMap.get(code);
                    // Send specific table
                    if (tableDeltaMap.has(table)) {
                        for (const link of tableDeltaMap.get(table).links) {
                            this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                        }
                    }
                    // Send any table
                    if (tableDeltaMap.has("*")) {
                        for (const link of tableDeltaMap.get("*").links) {
                            this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                        }
                    }
                }
                // Forward to PAYER listeners
                if (this.payerMap.has(payer)) {
                    decodedDeltaMsg = Buffer.from(msg.content).toString();
                    for (const link of this.payerMap.get(payer).links) {
                        this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                    }
                }
                break;
            }

            default: {
                console.log('Unindentified message!');
                console.log(msg);
            }
        }
        this.ch.ack(msg);
    }

    startRoutingRateMonitor() {
        setInterval(() => {
            if (this.totalRoutedMessages > 0) {
                hLog('[Router] Routing rate: ' + (this.totalRoutedMessages / 20) + ' msg/s');
                this.totalRoutedMessages = 0;
            }
        }, 20000);
    }

    countClients() {
        let total = 0;
        for (let key in this.relays) {
            if (this.relays.hasOwnProperty(key)) {
                if (this.relays[key].connected) {
                    total += this.relays[key].clients;
                }
            }
        }
        this.totalClients = total;
        hLog('Total WS clients:', this.totalClients);
    }

    appendToL1Map(
        target: Map<string, any>,
        primary: string,
        link: ActionLink | DeltaLink
    ) {
        if (target.has(primary)) {
            target.get(primary).links.push(link);
        } else {
            target.set(primary, {links: [link]});
        }
    }

    appendToL2Map(
        target: Map<string, any>,
        primary: string,
        secondary: string,
        link: ActionLink | DeltaLink
    ) {
        if (target.has(primary)) {
            const pMap = target.get(primary);
            if (pMap.has(secondary)) {
                const pLinks = pMap.get(secondary);
                pLinks.links.push(link);
            } else {
                pMap.set(secondary, {
                    links: [link]
                });
            }
        } else {
            const sMap = new Map();
            sMap.set(secondary, {
                links: [link]
            });
            target.set(primary, sMap);
        }
    }

    addActionRequest(data: any, id: string) {
        const req = data.request;
        if (typeof req.account !== 'string') {
            return {status: 'FAIL', reason: 'invalid request'};
        }
        if (greylist.indexOf(req.contract) !== -1) {
            if (req.account === '' || req.account === req.contract) {
                return {
                    status: 'FAIL',
                    reason: 'request too broad, please be more specific'
                };
            }
        }
        const link: ActionLink = {
            type: 'action',
            relay: id,
            client: data.client_socket,
            filters: req.filters,
            account: req.account,
            added_on: Date.now()
        };
        if (req.contract !== '' && req.contract !== '*') {
            this.appendToL2Map(this.codeActionMap, req.contract, req.action, link);
        } else {
            if (req.account !== '') {
                this.appendToL1Map(this.notifiedMap, req.account, link);
            } else {
                return {status: 'FAIL', reason: 'invalid request'};
            }
        }
        this.addToClientIndex(data, id, [req.contract, req.action, req.account]);
        return {
            status: 'OK'
        };
    }

    addToClientIndex(data: any, id: string, path: string[]) {
        // register client on index
        if (this.clientIndex.has(data.client_socket)) {
            this.clientIndex.get(data.client_socket).set(id, path);
            // console.log('new relay added to existing client');
        } else {
            const list = new Map();
            list.set(id, path);
            this.clientIndex.set(data.client_socket, list);
            // console.log('new client added to index');
        }
    }

    addDeltaRequest(data: any, id: string) {
        const req = data.request;
        const link: DeltaLink = {
            type: 'delta',
            relay: id,
            client: data.client_socket,
            filters: data.request.filters,
            payer: data.request.payer,
            added_on: Date.now()
        };
        if (req.code !== '' && req.code !== '*') {
            this.appendToL2Map(this.codeDeltaMap, req.code, req.table, link);
        } else {
            if (req.payer !== '' && req.payer !== '*') {
                this.appendToL1Map(this.payerMap, req.payer, link);
            } else {
                return {status: 'FAIL', reason: 'invalid request'};
            }
        }
        this.addToClientIndex(data, id, [req.code, req.table, req.payer]);
        return {
            status: 'OK'
        };
    }

    removeDeepLinks(map: Map<string, any>, path: string[], key: string, id: string) {
        if (map.has(path[0])) {
            if (map.get(path[0]).has(path[1])) {
                const currentLinks = map.get(path[0]).get(path[1]).links;
                currentLinks.forEach((item: BaseLink, index: number) => {
                    if (item.relay === key && item.client === id) {
                        currentLinks.splice(index, 1);
                    }
                });
            }
        }
    }

    removeSingleLevelLinks(map: Map<string, any>, path: string[], key: string, id: string) {
        if (map.has(path[2])) {
            const _links = map.get(path[2]).links;
            _links.forEach((item: BaseLink, index: number) => {
                if (item.relay === key && item.client === id) {
                    _links.splice(index, 1);
                }
            });
        }
    }

    removeLinks(id: string) {
        // console.log(`Removing links for ${id}...`);
        if (this.clientIndex.has(id)) {
            const links = this.clientIndex.get(id);
            links.forEach((path: string[], key: string) => {
                this.removeDeepLinks(this.codeActionMap, path, key, id);
                this.removeDeepLinks(this.codeDeltaMap, path, key, id);
                this.removeSingleLevelLinks(this.notifiedMap, path, key, id);
                this.removeSingleLevelLinks(this.payerMap, path, key, id);
            });
        }
    }

    initRoutingServer() {
        const server = createServer();
        this.io = new Server(server, {
            path: '/router',
            serveClient: false,
            cookie: false
        });

        this.io.on('connection', (socket: Socket) => {
            console.log(`[ROUTER] New relay connected with ID = ${socket.id}`);
            this.relays[socket.id] = {clients: 0, connected: true};
            socket.on('event', (data, callback) => {
                switch (data.type) {
                    case 'client_count': {
                        this.relays[socket.id]['clients'] = data.counter;
                        this.countClients();
                        break;
                    }
                    case 'action_request': {
                        const result = this.addActionRequest(data, socket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result.reason);
                        }
                        break;
                    }
                    case 'delta_request': {
                        const result = this.addDeltaRequest(data, socket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result.reason);
                        }
                        break;
                    }
                    case 'client_disconnected': {
                        this.removeLinks(data.id);
                        break;
                    }
                    default: {
                        console.log(data);
                    }
                }
            });
            socket.on('disconnect', () => {
                this.relays[socket.id].connected = false;
                this.countClients();
            });
        });

        const connOpts = this.manager.conn.chains[this.chain];

        let _port = 57200;
        if (connOpts.WS_ROUTER_PORT) {
            _port = connOpts.WS_ROUTER_PORT;
        }

        let _host = "127.0.0.1";
        if (connOpts.WS_ROUTER_HOST) {
            _host = connOpts.WS_ROUTER_HOST;
        }

        server.listen(_port, _host, () => {
            this.ready();
            setTimeout(() => {
                if (!this.firstData) {
                    this.ready();
                }
            }, 5000);
        });

    }

    ready() {
        process.send?.({event: 'router_ready'});
    }

    private forwardActionMessage(msg: any, link: any, notified: string[]) {
        let allow = false;
        const relay = this.io.of('/').sockets.get(link.relay);
        if (relay) {
            if (link.account !== '') {
                allow = notified.indexOf(link.account) !== -1;
            } else {
                allow = true;
            }
            if (link.filters?.length > 0) {
                // check filters
                const _parsedMsg = JSON.parse(msg);
                allow = link.filters.every((filter: any) => {
                    return checkFilter(filter, _parsedMsg);
                });
            }
            if (allow) {
                relay.emit('trace', {client: link.client, message: msg});
                this.totalRoutedMessages++;
            }
        }
    }

    private forwardDeltaMessage(msg: any, link: DeltaLink, payer: string) {
        let allow = false;
        const relay = this.io.of('/').sockets.get(link.relay);
        if (relay) {
            if (link.payer !== '') {
                allow = link.payer === payer;
            } else {
                allow = true;
            }
            // if (link.filters?.length > 0) {
            //     // check filters
            //     const _parsedMsg = JSON.parse(msg);
            //     allow = link.filters.every(filter => {
            //         return checkDeltaFilter(filter, _parsedMsg);
            //     });
            // }
            if (allow) {
                relay.emit('delta', {client: link.client, message: msg});
                this.totalRoutedMessages++;
            }
        }
    }
}
