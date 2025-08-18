export function startSignaling(pc: RTCPeerConnection) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/signal`
  const ws = new WebSocket(url)

  const handlers: Record<string, (msg:any)=>void> = {}

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      send({ type: 'answer', sdp: answer.sdp })
    } else if (handlers[msg.type]) {
      handlers[msg.type](msg)
    }
  }

  function send(obj:any) { ws.send(JSON.stringify(obj)) }
  function on(type:string, cb:(msg:any)=>void) { handlers[type]=cb }

  return { send, on }
}
