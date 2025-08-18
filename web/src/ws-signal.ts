export function startSignaling(pc: RTCPeerConnection) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/signal`
  const ws = new WebSocket(url)

  const handlers: Record<string, (msg:any)=>void> = {}
  const queue: string[] = []

  ws.onopen = () => {
    // Flush any messages that were queued while the socket was connecting
    while (queue.length > 0) ws.send(queue.shift()!)
  }

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

  function send(obj:any) {
    const data = JSON.stringify(obj)
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
    else queue.push(data)
  }
  function on(type:string, cb:(msg:any)=>void) { handlers[type]=cb }

  return { send, on }
}
