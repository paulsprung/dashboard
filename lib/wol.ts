import dgram from 'dgram';

export async function wakeOnLan(mac: string) {
  const clean = mac.replace(/[:-]/g, '');
  if (!/^[A-Fa-f0-9]{12}$/.test(clean)) throw new Error('Invalid MAC');
  const macBuf = Buffer.from(clean, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, 9, '255.255.255.255', (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}
