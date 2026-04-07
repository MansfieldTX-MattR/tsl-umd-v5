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


function readBufferField(buf: Buffer<ArrayBuffer>, field: MessageFieldName, extraOffset: number = 0): number {
    const offset = fieldOffsets[field] + extraOffset;
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

function writeBufferField(buf: Buffer<ArrayBuffer>, field: MessageFieldName, value: number, extraOffset: number = 0): void {
    const offset = fieldOffsets[field] + extraOffset;
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
            this.processTally(msg, rinfo.address)
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
                this.processTally(data, socket.remoteAddress)
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

    processTally(data: Buffer<ArrayBuffer>|string, source?: string) {
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
        const index = readBufferField(buf, 'INDEX')
        const control = readBufferField(buf, 'CONTROL')
        const textLength = readBufferField(buf, 'LENGTH')
        const textStart = fieldOffsets.LENGTH + fieldSizes.LENGTH;
        const text = buf.toString('ascii', textStart, textStart + textLength)

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
        this.emit('message', tally)
    }

    constructPacket(tally: Tally, sequence?: boolean): Buffer<ArrayBuffer> {
        let bufUMD = Buffer.alloc(12)

        if (tally.index !== 0 && !tally.index) {
            tally.index = 1 //default to index 1
        }

        writeBufferField(bufUMD, 'SCREEN', tally.screen)
        writeBufferField(bufUMD, 'INDEX', tally.index)

        if (tally.display) {
            let display = tally.display

            if (display.text){
                let text    = Buffer.from(display.text)
                let lenText = Buffer.byteLength(text)

                writeBufferField(bufUMD, 'LENGTH', lenText)
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

            writeBufferField(bufUMD, 'CONTROL', control)
        }
        //Calc length and write PBC
        let msgLength = Buffer.byteLength(bufUMD) - fieldSizes.PBC
        writeBufferField(bufUMD, 'PBC', msgLength)
        //Write VER and FLAGS
        writeBufferField(bufUMD, 'VER', this._VER)
        writeBufferField(bufUMD, 'FLAGS', 0x00) //no flags currently defined

        //Add DLE/STX and stuffing if needed
        if (sequence) {
            let packetBuf = Buffer.from([this._DLE, this._STX])

            for(let i = 0; i < bufUMD.length; i++) {
                if (bufUMD[i] == this._DLE) {
                    packetBuf = Buffer.concat([packetBuf, Buffer.from([this._DLE, this._DLE])])
                } else {
                    packetBuf = Buffer.concat([packetBuf, Buffer.from([bufUMD[i]])])
                }
            }
            return packetBuf

        } else {
            return bufUMD
        }
    }

    sendTallyUDP(ip: string, port: number, tally: Tally, sequence?: boolean) {
        try {
            if (!ip || !port || !tally){
                throw 'Missing Parameter from call sendTallyUDP()'
            }
            if (sequence === undefined) {
                debug('No DLE/STX sequence by default for UDP.')
                sequence = false
            }

            let msg = this.constructPacket(tally, sequence)

            let client = dgram.createSocket('udp4')

            client.send(msg, port, ip, function(error) {
                if (error) {
                    debug('Error sending TSL 5 UDP tally:', error)
                } else {
                    debug('TSL 5 UDP Data sent.')
                }
                client.close()
            });
        }
        catch (error) {
            debug('Error sending TSL 5 UDP tally:', error);
        }
    }

    sendTallyTCP(ip: string, port: number, tally: Tally, sequence?: boolean) {
        try {
            if (!ip || !port || !tally){
                throw 'Missing Parameter from call sendTallyTCP()'
            }
            if (sequence === undefined) {
                debug('Adding DLE/STX sequence by default for TCP.')
                sequence = true
            }

            let msg = this.constructPacket(tally, sequence)

            let client = new net.Socket()
            client.connect(port, ip);

            client.on('connect', () => {
                client.write(msg)
                client.end()
                client.destroy()
                debug('TSL 5 TCP Data sent.')

            })
            client.on('error', (error) => {
                debug('Error sending TSL 5 TCP tally:', error)
            })
        }
        catch (error) {
            debug('Error sending TSL 5 TCP tally:', error);
        }
    }
}

export default TSL5
