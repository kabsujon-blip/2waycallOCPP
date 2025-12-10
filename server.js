// Complete OCPP 1.6 Server - Full Bidirectional Support
// Supports: 10 Ports Control + Real-time Meter Data + Remote Commands

const BRIDGE_URL = Deno.env.get("BRIDGE_URL");
const BRIDGE_SECRET = Deno.env.get("BRIDGE_SECRET");

// OCPP 1.6 Message Types
const CALL = 2;
const CALLRESULT = 3;
const CALLERROR = 4;

// Store active WebSocket connections and pending commands
const activeConnections = new Map(); // stationId -> socket
const pendingCommands = new Map(); // messageId -> {resolve, reject, timeout}

console.log('🚀 Complete OCPP Server Starting...');
console.log('✅ Supports: Remote Control, Real-time Meter Data, 10 Ports');

// Helper: Call Base44 Bridge
async function callBridge(action, data) {
  try {
    const response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET
      },
      body: JSON.stringify({ action, data })
    });
    
    const result = await response.json();
    return result.success ? result.data : null;
  } catch (error) {
    console.error('Bridge error:', error);
    return null;
  }
}

// Helper: Send command to device and wait for response
async function sendCommandToDevice(stationId, action, payload, timeoutMs = 30000) {
  const socket = activeConnections.get(stationId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Device not connected');
  }

  const messageId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const ocppMessage = [CALL, messageId, action, payload || {}];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(messageId);
      reject(new Error('Command timeout'));
    }, timeoutMs);

    pendingCommands.set(messageId, { resolve, reject, timeout });
    
    console.log(`📤 Sending to ${stationId}:`, ocppMessage);
    socket.send(JSON.stringify(ocppMessage));
  });
}

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  
  // === HTTP COMMAND ENDPOINT ===
  if (url.pathname === '/command' && req.method === 'POST') {
    try {
      const { station_id, action, payload } = await req.json();
      
      if (!station_id || !action) {
        return Response.json({ 
          success: false, 
          error: 'Missing station_id or action' 
        }, { status: 400 });
      }

      const socket = activeConnections.get(station_id);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Response.json({ 
          success: false, 
          error: `Station ${station_id} not connected`
        }, { status: 404 });
      }

      // Send command and wait for response
      const response = await sendCommandToDevice(station_id, action, payload);

      return Response.json({ 
        success: true, 
        message: `Command ${action} sent successfully`,
        response
      });

    } catch (error) {
      return Response.json({ 
        success: false, 
        error: error.message 
      }, { status: 500 });
    }
  }

  // === WEBSOCKET HANDLING ===
  const pathParts = url.pathname.split('/');
  const stationId = pathParts[pathParts.length - 1];

  if (!stationId || stationId === 'ocpp16') {
    return new Response('Station ID required: /ocpp16/[station_id]', { status: 400 });
  }

  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = async () => {
    console.log(`✅ Device Connected: ${stationId}`);
    activeConnections.set(stationId, socket);
    
    await callBridge('registerStation', {
      station_id: stationId,
      name: `Station ${stationId}`,
      location: 'Auto-registered',
      status: 'available'
    });
  };

  socket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      const [messageType, messageId, actionOrResult, payload] = message;

      console.log(`📨 From ${stationId}:`, message);

      // === HANDLE COMMAND RESPONSES ===
      if (messageType === CALLRESULT || messageType === CALLERROR) {
        const pending = pendingCommands.get(messageId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCommands.delete(messageId);
          
          if (messageType === CALLRESULT) {
            pending.resolve(actionOrResult);
          } else {
            pending.reject(new Error(actionOrResult || 'Command failed'));
          }
        }
        return;
      }

      // === HANDLE DEVICE MESSAGES ===
      if (messageType === CALL) {
        const action = actionOrResult;
        let response;

        switch (action) {
          case 'BootNotification':
            response = {
              status: 'Accepted',
              currentTime: new Date().toISOString(),
              interval: 300
            };
            await callBridge('updateStation', {
              station_id: stationId,
              updates: {
                status: 'available',
                firmware_version: payload.chargePointModel || payload.firmwareVersion || 'Unknown',
                last_heartbeat: new Date().toISOString()
              }
            });
            break;
          
          case 'Heartbeat':
            response = { currentTime: new Date().toISOString() };
            await callBridge('updateStation', {
              station_id: stationId,
              updates: { last_heartbeat: new Date().toISOString() }
            });
            break;
          
          case 'StatusNotification':
            response = {};
            const statusMap = {
              'Available': 'available',
              'Charging': 'charging',
              'Faulted': 'error',
              'Unavailable': 'offline',
              'Preparing': 'available',
              'Finishing': 'available'
            };
            
            // Update station status based on connector status
            const newStatus = statusMap[payload.status] || 'offline';
            await callBridge('updateStation', {
              station_id: stationId,
              updates: { status: newStatus }
            });
            
            console.log(`📊 Port ${payload.connectorId} status: ${payload.status}`);
            break;
          
          case 'StartTransaction':
            response = await handleStartTransaction(stationId, payload);
            break;
          
          case 'StopTransaction':
            response = await handleStopTransaction(stationId, payload);
            break;
          
          case 'MeterValues':
            response = {};
            await handleMeterValues(stationId, payload);
            break;
          
          case 'Authorize':
            response = { idTagInfo: { status: 'Accepted' } };
            break;
          
          case 'DataTransfer':
            response = { status: 'Accepted' };
            break;
          
          default:
            console.log(`⚠️ Unhandled action: ${action}`);
            response = {};
        }

        socket.send(JSON.stringify([CALLRESULT, messageId, response]));
      }

    } catch (error) {
      console.error('Message handling error:', error);
      socket.send(JSON.stringify([CALLERROR, '', 'InternalError', error.message, {}]));
    }
  };

  socket.onclose = (event) => {
    console.log(`❌ Device Disconnected: ${stationId} (Code: ${event.code})`);
    activeConnections.delete(stationId);
  };

  socket.onerror = (error) => {
    console.error(`❌ WebSocket error on ${stationId}:`, error);
  };

  return response;
});

// === TRANSACTION HANDLERS ===
async function handleStartTransaction(stationId, payload) {
  try {
    const station = await callBridge('getStation', { station_id: stationId });
    if (!station) {
      return { transactionId: 0, idTagInfo: { status: 'Invalid' } };
    }

    const connectorId = payload.connectorId || 1;
    const session = await callBridge('createSession', {
      station_id: stationId,
      station_name: station.name,
      pricing_template_id: station.pricing_template_id || '',
      user_id: payload.idTag || 'unknown',
      user_email: payload.idTag || 'unknown@device.local',
      start_time: new Date().toISOString(),
      status: 'active',
      transaction_id: `${connectorId}-${Date.now()}`,
      meter_start: payload.meterStart || 0,
      energy_delivered: 0,
      duration_minutes: 0,
      cost: 0
    });

    await callBridge('updateStation', {
      station_id: stationId,
      updates: { status: 'charging' }
    });

    const transactionId = parseInt(session.id.replace(/\D/g, '').slice(0, 10)) || Math.floor(Math.random() * 1000000);
    console.log(`✅ Port ${connectorId} started charging (TxID: ${transactionId})`);

    return {
      transactionId,
      idTagInfo: { status: 'Accepted' }
    };
  } catch (error) {
    console.error('Start transaction error:', error);
    return { transactionId: 0, idTagInfo: { status: 'Invalid' } };
  }
}

async function handleStopTransaction(stationId, payload) {
  try {
    const station = await callBridge('getStation', { station_id: stationId });
    if (!station) {
      return { idTagInfo: { status: 'Invalid' } };
    }

    const session = await callBridge('getActiveSession', { station_id: stationId });

    if (session) {
      const startTime = new Date(session.start_time);
      const endTime = new Date();
      const durationMinutes = Math.floor((endTime - startTime) / 60000);
      const energyDelivered = ((payload.meterStop || 0) - (session.meter_start || 0)) / 1000;

      await callBridge('updateSession', {
        station_id: stationId,
        updates: {
          end_time: endTime.toISOString(),
          status: 'completed',
          duration_minutes: durationMinutes,
          energy_delivered: energyDelivered,
          meter_end: payload.meterStop || 0,
          cost: energyDelivered * 0.5
        }
      });

      await callBridge('updateStation', {
        station_id: stationId,
        updates: {
          status: 'available',
          total_energy_delivered: (station.total_energy_delivered || 0) + energyDelivered,
          total_sessions: (station.total_sessions || 0) + 1
        }
      });

      console.log(`✅ Transaction stopped - Energy: ${energyDelivered.toFixed(2)} kWh`);
    }

    return { idTagInfo: { status: 'Accepted' } };
  } catch (error) {
    console.error('Stop transaction error:', error);
    return { idTagInfo: { status: 'Invalid' } };
  }
}

async function handleMeterValues(stationId, payload) {
  try {
    if (!payload.meterValue || payload.meterValue.length === 0) return;

    const session = await callBridge('getActiveSession', { station_id: stationId });
    if (!session) return;

    const meterValue = payload.meterValue[0];
    if (!meterValue.sampledValue || meterValue.sampledValue.length === 0) return;

    // Extract meter readings
    let currentEnergy = null;
    let currentPower = null;
    let voltage = null;
    let current = null;

    meterValue.sampledValue.forEach(sample => {
      const value = parseFloat(sample.value);
      
      switch (sample.measurand) {
        case 'Energy.Active.Import.Register':
          currentEnergy = value;
          break;
        case 'Power.Active.Import':
          currentPower = value;
          break;
        case 'Voltage':
          voltage = value;
          break;
        case 'Current.Import':
          current = value;
          break;
      }
    });

    // Calculate energy delivered
    if (currentEnergy !== null) {
      const energyDelivered = (currentEnergy - (session.meter_start || 0)) / 1000; // Convert Wh to kWh
      const startTime = new Date(session.start_time);
      const now = new Date();
      const durationMinutes = Math.floor((now - startTime) / 60000);

      await callBridge('updateSession', {
        station_id: stationId,
        updates: {
          energy_delivered: energyDelivered,
          duration_minutes: durationMinutes
        }
      });

      console.log(`📊 Port ${payload.connectorId}: ${energyDelivered.toFixed(3)} kWh | Power: ${currentPower}W | V: ${voltage}V | A: ${current}A`);
    }

  } catch (error) {
    console.error('Meter values error:', error);
  }
}

console.log('🎯 Server ready on port 8080');
console.log('📍 WebSocket: ws://localhost:8080/ocpp16/[station_id]');
console.log('📍 Commands: http://localhost:8080/command');