import dgram from 'dgram'
import net from 'net'
import debug from 'debug'
import { EventEmitter } from 'events';

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

interface TallyMessage {
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
    message: [Tally];
}

class TSL5 extends EventEmitter<TSL5Events> {
    private _DLE: number = 0xFE
    private _STX: number = 0x02

    //Message Format
    private _PBC: number = 0 //offset
    private _VER: number = 2
    private _FLAGS: number = 3
    private _SCREEN: number = 4
    private _INDEX: number = 6
    private _CONTROL: number = 8
    private _LENGTH: number = 10
    constructor () {
        super()
    }

    listenUDP(port: number) {
        var server = dgram.createSocket('udp4')
        server.bind(port)

        server.on('message',(msg, rinfo) => {
            this.processTally(msg, rinfo.address)
            debug.log('UDP Message recieved: ', msg)
        })

        server.on('listening', () => {
            var address = server.address();
            debug.log(`server listening ${address.address}:${address.port}`);
        });

        server.on('error', (err) => {
            debug.log('UDP server error: ', err);
            throw err;
        });
    }

    listenTCP(port: number) {
        var server = net.createServer((socket) => {

            socket.on('data', (data) => {
                this.processTally(data, socket.remoteAddress)
                debug.log('TCP Message recieved: ', data)
            })

            socket.on('close', () => {
                debug.log('TCP socket closed')
            })

            socket.on('error', (err) => {
                debug.log('TCP server error: ', err);
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
        const pbc = buf.readInt16LE(this._PBC)
        const ver = buf.readInt8(this._VER)
        const flags = buf.readInt8(this._FLAGS)
        const screen = buf.readInt16LE(this._SCREEN)
        const index = buf.readInt16LE(this._INDEX)
        const control = buf.readInt16LE(this._CONTROL)
        const length = buf.readInt16LE(this._LENGTH)
        const text = buf.toString('ascii', this._LENGTH+2, this._LENGTH+2+length)

        const tally: TallyMessage = {
            sender: source ? source : undefined,
            pbc,
            ver,
            flags,
            screen,
            index,
            control,
            length,
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

    constructPacket(tally: TallyMessage, sequence?: boolean): Buffer<ArrayBuffer> {
        let bufUMD = Buffer.alloc(12)

        if (tally.index !== 0 && !tally.index) {
            tally.index = 1 //default to index 1
        }

        bufUMD.writeUInt16LE(tally.screen, this._SCREEN)
        bufUMD.writeUInt16LE(tally.index,  this._INDEX)

        if (tally.display) {
            let display = tally.display

            if (display.text){
                let text    = Buffer.from(display.text)
                let lenText = Buffer.byteLength(text)

                bufUMD.writeUInt16LE(lenText, this._LENGTH)
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

            bufUMD.writeUInt16LE(control, this._CONTROL)
        }
        //Calc length and write PBC
        let msgLength = Buffer.byteLength(bufUMD) - 2
        bufUMD.writeUInt16LE(msgLength, this._PBC)

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

    sendTallyUDP(ip: string, port: number, tally: TallyMessage, sequence?: boolean) {
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
                    debug.log('Error sending TSL 5 UDP tally:', error)
                } else {
                    debug.log('TSL 5 UDP Data sent.')
                }
                client.close()
            });
        }
        catch (error) {
            debug.log('Error sending TSL 5 UDP tally:', error);
        }
    }

    sendTallyTCP(ip: string, port: number, tally: TallyMessage, sequence?: boolean) {
        try {
            if (!ip || !port || !tally){
                throw 'Missing Parameter from call sendTallyTCP()'
            }
            if (sequence === undefined) {
                debug.log('Adding DLE/STX sequence by default for TCP.')
                sequence = true
            }

            let msg = this.constructPacket(tally, sequence)

            let client = new net.Socket()
            client.connect(port, ip);

            client.on('connect', () => {
                client.write(msg)
                client.end()
                client.destroy()
                debug.log('TSL 5 TCP Data sent.')

            })
            client.on('error', (error) => {
                debug.log('Error sending TSL 5 TCP tally:', error)
            })
        }
        catch (error) {
            debug.log('Error sending TSL 5 TCP tally:', error);
        }
    }
}

export default TSL5
