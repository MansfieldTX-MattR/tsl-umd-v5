import dgram from 'dgram'
import net from 'net'
import { debug as createDebug } from 'debug'
import { EventEmitter } from 'events';

const debug = createDebug('tsl-umd-v5')


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

export interface TallyMessage {
    sender?: string;
    pbc: number;
    ver: number;
    flags: number;
    screen: number;
    index: number;
    control: number;
    length: number;
    display: {
        text: string;
        rh_tally: TallyColor;
        text_tally: TallyColor;
        lh_tally: TallyColor;
        brightness: TallyColor;
        reserved: number;
        control_data: number;
    }
}

interface TSL5Events {
    message: [TallyMessage];
    messages: [TallyMessage[]];
}
interface MessageHeaderFieldInfo {
    PBC: number;
    VER: number;
    FLAGS: number;
    SCREEN: number;
}
interface MessageDmsgFieldInfo {
    INDEX: number;
    CONTROL: number;
    LENGTH: number;
}
type MessageFieldInfo = MessageHeaderFieldInfo & MessageDmsgFieldInfo;
type MessageFieldName = keyof MessageFieldInfo;


const fieldSizes: MessageFieldInfo = {
    PBC: 2,
    VER: 1,
    FLAGS: 1,
    SCREEN: 2,
    INDEX: 2,
    CONTROL: 2,
    LENGTH: 2,
} as const;

const fieldOffsets: MessageFieldInfo = {
    PBC: 0,
    VER: 2,
    FLAGS: 3,
    SCREEN: 4,
    INDEX: 6,
    CONTROL: 8,
    LENGTH: 10,
} as const;

const headerFieldSizes: MessageHeaderFieldInfo = {
    PBC: fieldSizes.PBC,
    VER: fieldSizes.VER,
    FLAGS: fieldSizes.FLAGS,
    SCREEN: fieldSizes.SCREEN,
}

const dmsgFieldSizes: MessageDmsgFieldInfo = {
    INDEX: fieldSizes.INDEX,
    CONTROL: fieldSizes.CONTROL,
    LENGTH: fieldSizes.LENGTH,
}

const messageHeaderSize = Object.values(headerFieldSizes).reduce((sum, size) => sum + size, 0);
const messageDmsgMinSize = Object.values(dmsgFieldSizes).reduce((sum, size) => sum + size, 0);
const maxPacketSize = 2048; // TSL 5 specification allows for a maximum packet size of 2048 bytes
const maxPayloadSize = maxPacketSize - messageHeaderSize; // The maximum payload (dmsg) size after accounting for the header


function readBufferField(buf: Buffer<ArrayBuffer>, field: MessageFieldName, extraOffset: number = 0, excludeHeader: boolean = false): number {
    let offset = fieldOffsets[field] + extraOffset;
    if (excludeHeader && field in headerFieldSizes) {
        offset -= messageHeaderSize;
    }
    const size = fieldSizes[field];
    switch (size) {
        case 1:
            return buf.readInt8(offset);
        case 2:
            return buf.readInt16LE(offset);
        default:
            throw new Error(`Unsupported field size: ${size}`);
    }
}

function writeBufferField(buf: Buffer<ArrayBuffer>, field: MessageFieldName, value: number, extraOffset: number = 0, excludeHeader: boolean = false): void {
    let offset = fieldOffsets[field] + extraOffset;
    if (excludeHeader && field in headerFieldSizes) {
        offset -= messageHeaderSize;
    }
    const size = fieldSizes[field];
    switch (size) {
        case 1:
            buf.writeInt8(value, offset);
            break;
        case 2:
            buf.writeInt16LE(value, offset);
            break;
        default:
            throw new Error(`Unsupported field size: ${size}`);
    }
}



class TSL5 extends EventEmitter<TSL5Events> {
    private _DLE: number = 0xFE
    private _STX: number = 0x02
    private _VER: number = 2
    constructor () {
        super()
    }

    listenUDP(port: number) {
        const server = dgram.createSocket({
            type: 'udp4',
            reuseAddr: true,
        })
        server.bind(port)

        server.on('message',(msg, rinfo) => {
            const tallies = this.processTallies(msg, rinfo.address)
            this.emit('messages', tallies)
            for (const tally of tallies) {
                this.emit('message', tally)
            }
            debug('UDP Message recieved: ', msg)
        })

        server.on('listening', () => {
            var address = server.address();
            debug(`server listening ${address.address}:${address.port}`);
        });

        server.on('error', (err) => {
            debug('UDP server error: ', err);
            throw err;
        });
    }

    listenTCP(port: number) {
        var server = net.createServer((socket) => {

            socket.on('data', (data) => {
                const tallies = this.processTallies(data, socket.remoteAddress)
                this.emit('messages', tallies)
                for (const tally of tallies) {
                    this.emit('message', tally)
                }
                debug('TCP Message recieved: ', data)
            })

            socket.on('close', () => {
                debug('TCP socket closed')
            })

            socket.on('error', (err) => {
                debug('TCP server error: ', err);
                throw err;
            })
        })
        server.listen(port)
    }

    processTallies(data: Buffer<ArrayBuffer>|string, source?: string): TallyMessage[] {
        let buf = Buffer.from(data)

        //Strip DLE/STX if present and un-stuff any DLE stuffing
        if (buf[0] == this._DLE && buf[1] == this._STX) {
            buf = buf.subarray(2)

            for (let index = 4; index < buf.length; index++) {

                if ((buf[index] == this._DLE) && (buf[index + 1] == this._DLE)) {
                  buf = Buffer.concat([buf.subarray(0, index), buf.subarray(index + 2)])
                }
              }
        }
        const pbc = readBufferField(buf, 'PBC')
        const ver = readBufferField(buf, 'VER')
        const flags = readBufferField(buf, 'FLAGS')
        const screen = readBufferField(buf, 'SCREEN')

        // Loop through the buffer to extract multiple tallies if present
        let offset = messageHeaderSize; // Start after the header
        const tallies: TallyMessage[] = [];

        const bufferLengthBytes = Buffer.byteLength(buf);
        if (bufferLengthBytes < messageHeaderSize) {
            debug('Received buffer is too short to contain a valid message header.');
            return [];
        }

        while (offset < bufferLengthBytes) {
            const index = readBufferField(buf, 'INDEX', offset, true);
            const control = readBufferField(buf, 'CONTROL', offset, true);
            const textLength = readBufferField(buf, 'LENGTH', offset, true);
            const textStart = offset - messageHeaderSize + fieldOffsets.LENGTH + fieldSizes.LENGTH;
            const text = buf.toString('ascii', textStart, textStart + textLength);
            const dmsgLength = messageDmsgMinSize + textLength;

            const tally: TallyMessage = {
                sender: source ? source : undefined,
                pbc,
                ver,
                flags,
                screen,
                index,
                control,
                length: textLength,
                display: {
                    text,
                    rh_tally: (control >> 0 & 0b11) as TallyColor,
                    text_tally: (control >> 2 & 0b11) as TallyColor,
                    lh_tally: (control >> 4 & 0b11) as TallyColor,
                    brightness: (control >> 6 & 0b11) as TallyColor,
                    reserved: (control >> 8 & 0b1111111),
                    control_data: (control >> 15 & 0b1),
                }
            }
            tallies.push(tally);
            offset += dmsgLength; // Move to the next DMSG
        }
        return tallies;
    }

    constructPackets(tallies: Tally[], sequence?: boolean): Buffer<ArrayBuffer>[] {
        const screenIndices = new Set(tallies.map(t => t.screen));
        if (screenIndices.size !== 1) {
            throw new Error('All tallies must have the same screen index to be sent in a single packet.');
        }
        const screenIndex = screenIndices.values().next().value;
        if (screenIndex === undefined) {
            throw new Error('At least one tally must be provided to construct packets.');
        }

        const packets: Buffer<ArrayBuffer>[] = [];
        let currentPacketTallies: Tally[] = [];
        let currentPacketDmsgBuffer = Buffer.alloc(0);
        let currentPacketSize = 0;

        for (const tally of tallies) {
            const displayPacket = this.constructPacket(tally, false, true);
            const tallySize = Buffer.byteLength(displayPacket);
            if (currentPacketSize + tallySize > maxPayloadSize) {
                const fullPacket = this.wrapDmsgPacket(screenIndex, currentPacketDmsgBuffer, sequence);
                packets.push(fullPacket);
                currentPacketTallies = [];
                currentPacketDmsgBuffer = Buffer.alloc(0);
                currentPacketSize = 0;
            }
            currentPacketTallies.push(tally);
            currentPacketDmsgBuffer = Buffer.concat([currentPacketDmsgBuffer, displayPacket]);
            currentPacketSize += tallySize;
        }

        if (currentPacketTallies.length > 0) {
            const fullPacket = this.wrapDmsgPacket(screenIndex, currentPacketDmsgBuffer, sequence);
            packets.push(fullPacket);
        }
        return packets;
    }

    private wrapDmsgPacket(screen: number, payload: Buffer<ArrayBuffer>, sequence?: boolean): Buffer<ArrayBuffer> {
        // Add PBC, VER, FLAGS, SCREEN to the beginning of the payload
        const header = Buffer.alloc(12);
        writeBufferField(header, 'PBC', Buffer.byteLength(payload));
        writeBufferField(header, 'VER', this._VER);
        writeBufferField(header, 'FLAGS', 0x00); // No flags currently defined
        writeBufferField(header, 'SCREEN', screen); // Set the screen index

        let packetBuf = Buffer.concat([header, payload]);

        // Add DLE/STX and stuffing if needed
        if (sequence) {
            return this.stuffDLESTX(packetBuf)
        } else {
            return packetBuf;
        }
    }

    constructPacket(tally: Tally, sequence?: boolean, dmsgOnly?: boolean): Buffer<ArrayBuffer> {
        let bufUMD = Buffer.alloc(dmsgOnly ? messageDmsgMinSize : 12)
        const excludeHeader = dmsgOnly ? true : false;

        if (tally.index !== 0 && !tally.index) {
            tally.index = 1 //default to index 1
        }

        if (!dmsgOnly) {
            // The screen field is outside of the DMSG
            writeBufferField(bufUMD, 'SCREEN', tally.screen, 0, excludeHeader)
        }
        writeBufferField(bufUMD, 'INDEX', tally.index, 0, excludeHeader)

        if (tally.display) {
            let display = tally.display

            if (display.text){
                let text    = Buffer.from(display.text)
                let lenText = Buffer.byteLength(text)

                writeBufferField(bufUMD, 'LENGTH', lenText, 0, excludeHeader)
                bufUMD = Buffer.concat([bufUMD, text]) //append text
            }
            if (!display.brightness) {
                display.brightness = 3 //default to brightness 3
            }

            let control = 0x00
            control |= display.rh_tally << 0
            control |= display.text_tally << 2
            control |= display.lh_tally << 4
            control |= display.brightness << 6

            writeBufferField(bufUMD, 'CONTROL', control, 0, excludeHeader)
        }

        if (!dmsgOnly) {
            //Calc length and write PBC
            // excludeHeader should be true here
            let msgLength = Buffer.byteLength(bufUMD) - fieldSizes.PBC
            writeBufferField(bufUMD, 'PBC', msgLength)
            //Write VER and FLAGS
            writeBufferField(bufUMD, 'VER', this._VER)
            writeBufferField(bufUMD, 'FLAGS', 0x00) //no flags currently defined
        }

        //Add DLE/STX and stuffing if needed
        if (sequence && !dmsgOnly) {
            return this.stuffDLESTX(bufUMD)
        } else {
            return bufUMD
        }
    }

    private stuffDLESTX(bufUMD: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
        let packetBuf = Buffer.from([this._DLE, this._STX])

        for(let i = 0; i < bufUMD.length; i++) {
            if (bufUMD[i] == this._DLE) {
                packetBuf = Buffer.concat([packetBuf, Buffer.from([this._DLE, this._DLE])])
            } else {
                packetBuf = Buffer.concat([packetBuf, Buffer.from([bufUMD[i]])])
            }
        }
        return packetBuf
    }

    sendTallyUDP(ip: string, port: number, tally: Tally|Tally[], sequence?: boolean): Promise<void> {
        if (!Array.isArray(tally)) {
            tally = [tally]
        }
        try {
            if (!ip || !port || !tally || tally.length === 0){
                throw 'Missing Parameter from call sendTallyUDP()'
            }
            if (sequence === undefined) {
                debug('No DLE/STX sequence by default for UDP.')
                sequence = false
            }

            const packets = this.constructPackets(tally, sequence)
            return this.sendPacketsUDP(ip, port, packets)
        }
        catch (error) {
            debug('Error sending TSL 5 UDP tally:', error);
            return Promise.reject(error);
        }
    }

    async sendPacketsUDP(ip: string, port: number, packets: Buffer<ArrayBuffer>[]) {
        const allPromises: Promise<void>[] = [];
        try {
            if (!ip || !port || !packets || packets.length === 0){
                throw 'Missing Parameter from call sendPacketsUDP()'
            }

            let client = dgram.createSocket('udp4')

            for (const packet of packets) {
                const sendPromise = new Promise<void>((resolve, reject) => {
                    client.send(packet, port, ip, function(error) {
                        if (error) {
                            debug('Error sending TSL 5 UDP tally:', error)
                            reject(error);
                        } else {
                            debug('TSL 5 UDP Data sent.')
                            resolve();
                        }
                    });
                });
                allPromises.push(sendPromise);
            }
            await Promise.all(allPromises);
            client.close()
        }
        catch (error) {
            debug('Error sending TSL 5 UDP tally:', error);
            return Promise.reject(error);
        }
    }

    sendTallyTCP(ip: string, port: number, tally: Tally|Tally[], sequence?: boolean): Promise<void> {
        if (!Array.isArray(tally)) {
            tally = [tally]
        }
        try {
            if (!ip || !port || !tally || tally.length === 0){
                throw 'Missing Parameter from call sendTallyTCP()'
            }
            if (sequence === undefined) {
                debug('Adding DLE/STX sequence by default for TCP.')
                sequence = true
            }

            const packets = this.constructPackets(tally, sequence)
            return this.sendPacketsTCP(ip, port, packets, sequence)
        }
        catch (error) {
            debug('Error sending TSL 5 TCP tally:', error);
            return Promise.reject(error);
        }
    }

    async sendPacketsTCP(ip: string, port: number, packets: Buffer<ArrayBuffer>[], sequence?: boolean) {
        try {
            if (!ip || !port || !packets || packets.length === 0){
                throw 'Missing Parameter from call sendPacketsTCP()'
            }
            if (sequence === undefined) {
                debug('Adding DLE/STX sequence by default for TCP.')
                sequence = true
            }

            const sendPromise = new Promise<void>((resolve, reject) => {
                let client = new net.Socket()
                client.connect(port, ip);

                client.on('connect', () => {
                    for (const packet of packets) {
                        client.write(packet)
                    }
                    client.end()
                    client.destroy()
                    debug('TSL 5 TCP Data sent.')
                    resolve();
                })
                client.on('error', (error) => {
                    debug('Error sending TSL 5 TCP tally:', error)
                    reject(error);
                })
            });
            await sendPromise;
        }
        catch (error) {
            debug('Error sending TSL 5 TCP tally:', error);
            return Promise.reject(error);
        }
    }
}

export default TSL5
