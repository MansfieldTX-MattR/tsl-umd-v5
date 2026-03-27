import { EventEmitter } from "events";


declare module "tsl-umd-v5" {
    export type TallyColor = 0 | 1 | 2 | 3
    export type TallyType = "rh_tally" | "text_tally" | "lh_tally";
    export type TallyDisplay = {
        [key in TallyType]: TallyColor;
    } & {
        brightness?: number;
        text?: string;
    }

    export interface Tally {
        screen: number;
        index: number;
        display?: TallyDisplay;
    }

    interface TSL5Events {
        message: [Tally];
    }

    export default class TSL5 extends EventEmitter<TSL5Events> {
        constructor();
        listenUDP(port: number): void;
        listenTCP(port: number): void;
        processTally(data: Buffer<ArrayBuffer>, source?: string): void;
        constructPacket(tally: Tally, sequence?: boolean): Buffer<ArrayBuffer>;
        sendTallyUDP(ip: string, port: number, tally: Tally, sequence?: boolean): void;
        sendTallyTCP(ip: string, port: number, tally: Tally, sequence?: boolean): void;
    }
}
