import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { setupServerNonStreamHandlers } from '../lib/non_stream.js';
import { setupServerStreamHandlers, forwardStreamData } from '../lib/stream.js';
import { NAMESPACES, MSG_TYPE } from '../lib/constants.js';
import { uuidv4 } from '../lib/uuid/uuid.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
//import * as functionCall from './dist/function_call.js';

import { readJsonFromFile , saveJsonToFile } from './dist/function_call.js';

// 导入模块
import * as Rooms from './dist/Rooms.js';
import * as Keys from './dist/Keys.js';
//import * as Passwords from './dist/Passwords.js'; // 如果使用了单独的密码文件

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const saltRounds = 10;

let io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  serveClient: true,
});

let tempmap = new Map();

let serverSettings = {
  serverPort: 4000,
  serverAddress: 'http://localhost',
  reconnectAttempts: 5,
  reconnectDelay: 1000,
  timeout: 5000,
  autoConnect: true,
  socketIOPath: '/socket.io',
  queryParameters: {},
  transport: 'websocket',
  Rooms: [], // 初始化为空对象
  clientKeys: {}, //新增：初始化
  Remember_me: false,
  sillyTavernPassword: new Map()
};

let trustedSillyTaverns = new Set();

let trustedClients = new Set(); 

let  sillyTavernkey = new Map();

/**
 * @description 从文件加载服务器设置，自动设置可信客户端/SillyTavern，并确保密码已哈希 / Loads server settings, auto-sets trusted clients/SillyTaverns, and ensures passwords are hashed.
 * @function loadServerSettings
 * @returns {void}
 */
async function loadServerSettings() { // 改为 async 函数
  try {
    const settingsData = fs.readFileSync(join(__dirname, './settings/server_settings.json'), 'utf-8');
    serverSettings = { ...serverSettings, ...JSON.parse(settingsData) };
    console.log('Server settings loaded from file.');
  } catch (error) {
    console.log('No settings file found or error loading settings. Using default settings.');
    fs.writeFileSync(join(__dirname, './settings/server_settings.json'), JSON.stringify(serverSettings, null, 2), 'utf-8');
  }
  let sillyTavernPassword = null;
  // 自动设置可信客户端/SillyTavern
  try {
      const settingsDir = join(__dirname, './settings');
      const files = fs.readdirSync(settingsDir);

      for (const file of files) {
        if (file === 'server_settings.json') {
          continue; // 跳过服务器设置文件
        }

        if (!file.endsWith('.json')) {
            continue; // 跳过非 JSON 文件
        }

        try {
          const filePath = join(settingsDir, file);
          const fileData = fs.readFileSync(filePath, 'utf-8');
          const jsonData = JSON.parse(fileData);
          if (jsonData.hasOwnProperty('clientId') && jsonData.hasOwnProperty('isTrust')) {
            const { clientId, isTrust } = jsonData;
            if (jsonData.hasOwnProperty('sillyTavernPassWord')){
              sillyTavernPassword = jsonData.sillyTavernPassWord
            };
            if (isTrust) {
              if (clientId.startsWith('SillyTavern')) {
                trustedSillyTaverns.add(clientId);
                serverSettings.Rooms.push(clientId);
                //console.log('serverSettings.Rooms:', serverSettings.Rooms);
                serverSettings.sillyTavernPassword.set( clientId , sillyTavernPassword );
                //console.log(
                  //serverSettings.sillyTavernPassword:',
                  //serverSettings.sillyTavernPassword,
                //);
                const stkey = await Keys.generateAndStoreClientKey(clientId);

                sillyTavernkey.set(clientId , stkey)

                console.log(`Added trusted SillyTavern: ${clientId}`);
              } else {
                trustedClients.add(clientId);
                serverSettings.Rooms.push(clientId);
                Keys.generateAndStoreClientKey(clientId);
                console.log(`Added trusted client: ${clientId}`);
              }
            }
          }else {
              console.warn(`Skipping file ${file} due to missing clientId or isTrust property.`);
          }
        } catch (parseError) {
          console.error(`Error parsing JSON in file ${file}:`, parseError);
        }
      }
    } catch (readDirError) {
      console.error('Error reading settings directory:', readDirError);
    }

  // 检查和哈希 SillyTavern 密码
  if (serverSettings.sillyTavernPassword) {
    let passwordsChanged = false; // 标记密码是否被修改
    for (let clientId of serverSettings.sillyTavernPassword.keys()) {
        console.log('clientId:', clientId);
        let passwordEntry = serverSettings.sillyTavernPassword.get(clientId);

        // 检查密码是否已经被哈希 (通过检查是否是字符串且以 $ 开头，这是一个简单的约定)
        if (typeof passwordEntry === 'string' && !passwordEntry.startsWith('$')) {
          // 没有哈希，进行哈希
          const hashedPassword = await bcrypt.hash(passwordEntry, saltRounds);
          serverSettings.sillyTavernPassword.set(clientId, hashedPassword); //直接存储
          passwordsChanged = true;
          saveJsonToFile(`./settings/${clientId}-settings.json`, { "sillyTavernMasterKey": hashedPassword });
          console.log(`Hashed password for SillyTavern client: ${clientId}`);
        } else if (
          typeof passwordEntry === 'object' &&
          passwordEntry !== null &&
          passwordEntry.hasOwnProperty('hashed') &&
          passwordEntry.hashed === false
        ) {
          // 兼容旧版本
          const hashedPassword = await bcrypt.hash(passwordEntry.password, saltRounds);
          serverSettings.sillyTavernPassword.set(clientId , hashedPassword); //直接存储
          passwordsChanged = true;
          saveJsonToFile(`./settings/${clientId}-settings.json`, { "sillyTavernMasterKey": hashedPassword });
          console.log(`Hashed password for SillyTavern client: ${clientId}`);
        }
      
    }

    // 如果密码被修改，保存到文件
    if (passwordsChanged) {
      //saveServerSettings(serverSettings);
    }
  }
}

/**
 * @description 将服务器设置保存到文件 / Saves server settings to a file.
 * @function saveServerSettings
 * @param {object} newSettings - 要保存的新设置 / New settings to save.
 * @returns {void}
 */
function saveServerSettings(newSettings) {
  try {
    fs.writeFileSync(join(__dirname, './settings/server_settings.json'), JSON.stringify(newSettings, null, 2), 'utf-8');
    console.log('Server settings saved successfully.');
  } catch (error) {
    console.error('Failed to save server settings:', error);
  }
}

loadServerSettings();

/**
 * @description 重新初始化 Socket.IO 服务器 / Reinitializes the Socket.IO server.
 * @function reinitializeSocketIO
 * @param {object} newSettings - 新的服务器设置 / New server settings.
 * @returns {void}
 */
function reinitializeSocketIO(newSettings) {
  serverSettings = { ...serverSettings, ...newSettings };
  io.of(NAMESPACES.GENERAL).removeAllListeners();
  setupServerNonStreamHandlers(io, NAMESPACES.GENERAL);
  const forwardHandler = forwardStreamData(io, NAMESPACES.GENERAL, 'monitor-room'); //必须要有monitor-room
  setupServerStreamHandlers(io, NAMESPACES.GENERAL, forwardHandler);
}

let requestQueue = [];


/**
 * @description 处理 LLM 请求 / Processes the LLM request.
 * @function processLLMRequest
 * @param {string} target - 目标 SillyTavern 实例的 clientId / Target SillyTavern client ID.
 * @param {object} request - 请求对象 / Request object.
 * @returns {void}
 */
function processLLMRequest(target, request) {
  if (trustedSillyTaverns.has(target)) {
    io.of(NAMESPACES.SILLY_TAVERN).to(target).emit(MSG_TYPE.LLM_REQUEST, request);
    console.log(`Forwarding LLM request to SillyTavern: ${target}`);
  } else {
    console.warn(`Target SillyTavern not found: ${target}`);
    // 可以选择向请求的发起者发送错误消息
    if (request.clientId) { // 确保请求包含 clientId
        io.of(NAMESPACES.AUTH).to(request.clientId).emit(MSG_TYPE.ERROR, {  // 假设错误消息发送回 /auth
          type: MSG_TYPE.ERROR,
          message: `Target SillyTavern not found: ${target}`,
          requestId: request.requestId, // 包含请求 ID
      });
    }
  }
}

const functionRegistry = {};

/**
 * @description 注册一个函数以供 function_call 调用 / Registers a function for function_call.
 * @function registerFunction
 * @param {string} name - 函数名称 / The name of the function.
 * @param {Function} func - 要注册的函数 / The function to register.
 * @returns {void}
 */
function registerFunction(name, func) {
  if (functionRegistry[name]) {
    console.warn(`Function "${name}" is already registered. Overwriting.`);
  }
  functionRegistry[name] = func;
  console.log(`Function "${name}" registered for function_call.`);
}

// 在服务器启动时注册函数
import * as functionCall from './dist/function_call.js'; // 导入所有函数
for (const functionName in functionCall) {
  if (typeof functionCall[functionName] === 'function') {
    registerFunction(functionName, functionCall[functionName]);
  }
}

/**
 * @description 处理 function_call 请求 / Handles a function_call request.
 * @function handleFunctionCallRequest
 * @async
 * @param {import('socket.io').Socket} socket - Socket.IO Socket 实例 / Socket.IO Socket instance.
 * @param {object} data - 请求数据 / Request data.
 * @param {string} data.requestId - 请求 ID / Request ID.
 * @param {string} data.functionName - 要调用的函数名称 / Name of the function to call.
 * @param {any[]} data.args - 函数参数 / Function arguments.
 * @param {Function} callback - 回调函数 / Callback function.
 * @returns {Promise<void>}
 */
async function handleFunctionCallRequest(socket, data, callback) {
  const { requestId, functionName, args, target } = data; // 添加 target

  if (target === 'server') {
    // 服务器端函数调用
    const func = functionRegistry[functionName];
    if (!func) {
      console.warn(`Function "${functionName}" not found.`);
      callback({
        requestId,
        success: false,
        error: { message: `Function "${functionName}" not found.` },
      });
      return;
    }

    try {
      const result = await func(...args);
      callback({ requestId, success: true, result });
    } catch (error) {
      console.error(`Error calling function "${functionName}":`, error);
      callback({
        requestId,
        success: false,
        error: { message: error.message || 'An unknown error occurred.' },
      });
    }
  } else {
    // 转发给 SillyTavern 扩展
    io.to(target).emit(MSG_TYPE.FUNCTION_CALL, data, callback);
  }
}

/**
 * @description 验证客户端密钥 / Validates a client's key.
 * @function isValidKey
 * @async
 * @param {string} clientId - 客户端 ID / The client ID.
 * @param {string} key - 客户端提供的密钥 / The key provided by the client.
 * @returns {Promise<boolean>} - 如果密钥有效，则返回 true；否则返回 false / True if the key is valid, false otherwise.
 */
async function isValidKey(clientId, key) {
  if (trustedSillyTaverns.has(clientId)) {
    // 如果是 SillyTavern，从 Keys 中获取并验证
    const storedKey = Keys.getClientKey(clientId);
    if (!storedKey) {
      return false; // 没有找到密钥
    }
    return await bcrypt.compare(String(key), storedKey);
  } else {
    return await Keys.isValidClientKey(clientId, key);
  }
}

/**
 * @description 检查发送者是否有权限向目标房间发送消息 / Checks if a sender is allowed to send a message to a target room.
 * @function canSendMessage
 * @param {string} senderClientId - 发送者客户端 ID / The sender's client ID.
 * @param {string} targetRoom - 目标房间名称 / The target room name.
 * @returns {boolean} - 如果允许发送，则返回 true；否则返回 false / True if sending is allowed, false otherwise.
 */
function canSendMessage(senderClientId, targetRoom) {
  if (targetRoom === 'server') {
    return true;
  }

  if (trustedSillyTaverns.has(senderClientId)) {
    return true;
  }

  // 使用 Rooms.isClientInRoom() 检查客户端是否在房间内
  if (Rooms.isClientInRoom(senderClientId, targetRoom)) {
    return true;
  }

  return false;
}

// 默认命名空间 (/)
io.on('connection', async (socket) => {
  const clientType = socket.handshake.auth.clientType;
  const clientId = socket.handshake.auth.clientId;

  if (!clientId) {
    console.warn('Client connected without clientId. Disconnecting.');
    socket.disconnect(true);
    return;
  }

  if (clientType === 'monitor') {
    console.log('Monitor client connected');
    socket.join('monitor-room'); // 监控客户端仍然在默认命名空间
  } else if (clientType === 'extension') {
    console.log(`Extension client connected: ${clientId}`);
     // 为扩展分配唯一房间，仅用于保证后续能通过房间找到对应的 socket。  实际的房间管理在 /rooms 命名空间
    socket.join(clientId);
  } else if (clientType === 'extension-Login') { //这个没啥用
    console.log(`Client ${clientId} is Logined.`);
  } else if (clientType === 'extension-checkRememberMe') { //这个也没啥用
    console.log(`Client ${clientId} is checking isRememberMe.`);
  }

  socket.on('disconnect', (reason) => {
    console.log(`Client ${clientId} disconnected: ${reason}`);

    // 注意：这里的重连尝试逻辑 *只* 针对那些 *没有* 在其他命名空间（如 /auth）中处理重连的客户端。
    // 对于 extension 类型的客户端，重连逻辑在 /auth 命名空间中。

    // 启动重试机制 (仅针对 monitor, 因为 extension 在 /auth 中处理)
    // 如果你还有其他类型的客户端需要在默认命名空间中处理，也需要在这里添加重试逻辑。
    if (clientType === 'monitor') {
      let attempts = 0;
      const reconnectInterval = setInterval(() => {
        if (socket.connected) {
          clearInterval(reconnectInterval);
          console.log(`Client ${clientId} reconnected.`);
        } else {
          attempts++;
          if (attempts >= serverSettings.reconnectAttempts) { // 使用 serverSettings
            clearInterval(reconnectInterval);
            console.log(`Client ${clientId} failed to reconnect.`);
          } else {
            console.log(
              `Client ${clientId} disconnected. Reconnect attempt ${attempts}/${serverSettings.reconnectAttempts}...`,
            );
          }
        }
      }, serverSettings.reconnectDelay); // 使用 serverSettings
    }
  });
});

// /auth 命名空间
const authNsp = io.of(NAMESPACES.AUTH);



authNsp.on('connection', async socket => {
  const clientType = socket.handshake.auth.clientType;
  const clientId = socket.handshake.auth.clientId;
  const clientKey = socket.handshake.auth.key;
  const clientDesc = socket.handshake.auth.desc;

  // 用于存储重连间隔的映射，键为 clientId
  const reconnectIntervals = {};

  // 新增：临时房间映射
  const tempRooms = {};

  
  if (trustedClients.has(clientId) || trustedSillyTaverns.has(clientId)) {
    // 可信客户端
    if (!(await isValidKey(clientId, clientKey))) {
      // 密钥验证失败：创建临时房间
      console.warn(
        `Client ${clientId} provided invalid key. Creating temporary room. socket.handshake.auth:`,
        socket.handshake.auth,
      );

      const tempRoomId = `temp_${clientId}`;
      tempRooms[clientId] = tempRoomId;
      socket.join(tempRoomId);
      socket.emit(MSG_TYPE.TEMP_ROOM_ASSIGNED, { roomId: tempRoomId });
      // 注意: 这里不 return，允许临时房间中的客户端继续接收某些事件
    } else {
      // 密钥验证通过，设置房间
      try {
        Rooms.createRoom(socket, clientId); // 如果房间已存在，不会报错
        Rooms.addClientToRoom(socket, clientId);
        Rooms.setClientDescription(clientId, clientDesc);
        socket.join(clientId); // 加入以 clientId 命名的房间
        console.log(`Client ${clientId} connected and joined room ${clientId}`);
        if(trustedClients.has(clientId)){
          Keys.generateAndStoreClientKey(clientId);
        }
      } catch (error) {
        console.error('Error setting up client:', error);
        // 可以选择向客户端发送错误消息
      }
    }
  } else {
    // 不可信客户端，直接断开连接
    console.warn(`Client ${clientId} is not trusted. Disconnecting. socket.handshake.auth:`, socket.handshake.auth);
    socket.emit(MSG_TYPE.ERROR, { message: 'Client is not trusted.' });
    socket.disconnect(true);
    return;
  }

  if (clientKey === 'getKey' && trustedSillyTaverns.has(clientId)) {
    // SillyTavern 首次连接，请求密钥 (通常发生在 SillyTavern 扩展第一次连接时)
    console.log(`SillyTavern client ${clientId} requesting key.`);
    console.log('socket.handshake:',socket.handshake);
    let SILLYTAVERN_key = await Keys.generateAndStoreClientKey(clientId);
    console.log(`Generated key for SillyTavern ${clientId}: ${SILLYTAVERN_key}`);

    Rooms.createRoom(socket, clientId); // 如果房间已存在，不会报错
    Rooms.addClientToRoom(socket, clientId);
    Rooms.setClientDescription(clientId, clientDesc);
    socket.join(clientId); // 加入以 clientId 命名的房间

    socket.emit('message', {
      type: MSG_TYPE.GET_CLIENT_KEY, // 使用自定义的消息类型
      key: SILLYTAVERN_key,
      clientId: clientId, // 包含 clientId
    });
  }

  // 监听 GET_CLIENT_KEY
  socket.on(MSG_TYPE.GET_CLIENT_KEY, async (data, callback) => {
    // 只有 SillyTavern 可以获取客户端密钥
    if (!trustedSillyTaverns.has(clientId)) {
      if (callback) callback({ status: 'error', message: 'Unauthorized' });
      return;
    }
    const targetClientId = data.clientId;
    const key = Keys.getClientKey(targetClientId);
    if (key) {
      if (callback) callback({ status: 'ok', key: key });
    } else {
      if (callback) callback({ status: 'error', message: 'Client key not found.' });
    }
  });

  // 监听 LOGIN
  socket.on(MSG_TYPE.LOGIN, async (data, callback) => {
    //data: {password: string}
    const { clientId, password } = data;
    
    if (serverSettings.sillyTavernPassword) {
      //const func_ReadJsonFromFile = functionRegistry[readJsonFromFile];
      const jsonData = await readJsonFromFile(`./settings/${clientId}-settings.json`);
      console.log('jsonData.result.sillyTavernMasterKey:', jsonData.result.sillyTavernMasterKey);
      const isMatch = await bcrypt.compare(password, jsonData.result.sillyTavernMasterKey);
      if (isMatch) {
        if (callback) callback({ success: true });
      } else {
        if (callback) callback({ success: false, message: 'Incorrect password.' });
      }
    } else {
      if (callback) callback({ success: false, message: 'Password not set on server.' });
    }
  });

  // 断开连接
  socket.on('disconnect', reason => {
    const clientId = socket.handshake.auth.clientId;

    // 如果是 SillyTavern 断开，从 trustedSillyTaverns 中移除
    if (trustedSillyTaverns.has(clientId)) {
      //trustedSillyTaverns.delete(clientId);
      console.log(`SillyTavern with clientId ${clientId} disconnected.`);
    }

    // 检查是否在临时房间
    if (tempRooms[clientId]) {
      console.log(`Client ${clientId} disconnected from temporary room ${tempRooms[clientId]}`);
      delete tempRooms[clientId];
    } else {
      // 仅对非临时房间的、可信的客户端启动重试机制
      if (trustedClients.has(clientId) || trustedSillyTaverns.has(clientId)) {
        let attempts = 0;
        if (reconnectIntervals[clientId]) {
          clearInterval(reconnectIntervals[clientId]);
          delete reconnectIntervals[clientId];
        }

        const reconnectInterval = setInterval(() => {
          let alreadyConnected = false;
          authNsp.sockets.forEach(existingSocket => {
            if (existingSocket.handshake.auth.clientId === clientId && existingSocket.id !== socket.id) {
              alreadyConnected = true;
            }
          });

          if (alreadyConnected) {
            clearInterval(reconnectInterval);
            delete reconnectIntervals[clientId];
            console.log(`Client ${clientId} reconnected with a different socket. Stopping retry.`);
            try {
              Rooms.addClientToRoom(socket, clientId);
            } catch (error) {
              console.error('Error re-adding client to room:', error);
            }
            return;
          }
          attempts++;
          if (attempts >= serverSettings.reconnectAttempts) {
            clearInterval(reconnectInterval);
            delete reconnectIntervals[clientId];
            try {
              Rooms.deleteRoom(socket, clientId);
            } catch (error) {
              console.error('Error deleting room:', error);
            }
            console.log(`Client ${clientId} failed to reconnect. Room ${clientId} deleted.`);

            // 通知所有 SillyTavern 实例
            trustedSillyTaverns.forEach(stClientId => {
              io.of(NAMESPACES.SILLY_TAVERN)
                .to(stClientId) // 使用 clientId，而不是 socketId
                .emit(MSG_TYPE.ERROR, {
                  type: MSG_TYPE.ERROR,
                  message: `Client ${clientId} disconnected and failed to reconnect. Room deleted.`,
                });
            });
          } else {
            console.log(
              `Client ${clientId} disconnected. Reconnect attempt ${attempts}/${serverSettings.reconnectAttempts}...`,
            );
          }
        }, serverSettings.reconnectDelay);

        reconnectIntervals[clientId] = reconnectInterval;
      }
    }
  });
});

// /clients 命名空间
const clientsNsp = io.of(NAMESPACES.CLIENTS);
clientsNsp.on('connection', (socket) => {
  // 监听 GENERATE_CLIENT_KEY, REMOVE_CLIENT_KEY, getClientList, getClientsInRoom
  const clientId = socket.handshake.auth.clientId;
  console.log(`Client ${clientId} connected to ${NAMESPACES.CLIENTS} namespace`);
  socket.on(MSG_TYPE.GET_CLIENT_KEY, async (data, callback) => {
    if (trustedSillyTaverns.has(clientId)) {
      if (callback) callback({ status: 'error', message: 'Unauthorized' });
      return;
    }
    const targetClientId = data.clientId;
    try {
      const key = Keys.clientKeys;
      if (callback && key !== null) {
        callback({ status: 'ok', key: key });
      }
      else {
        callback({ status: 'error', message: 'No keys in stroge!' });
      }
    } catch (error) {
      if (callback) callback({ status: 'error', message: error.message });
    }
  });

  socket.on(MSG_TYPE.GENERATE_CLIENT_KEY, async (data, callback) => {
    if (trustedSillyTaverns.has(clientId)) {
      if (callback) callback({ status: 'error', message: 'Unauthorized' });
      return;
    }
    const targetClientId = data.clientId;
    try {
      const key = await Keys.generateAndStoreClientKey(targetClientId);
      if (callback) callback({ status: 'ok', key: key });
    } catch (error) {
      if (callback) callback({ status: 'error', message: error.message });
    }
  });

  socket.on(MSG_TYPE.REMOVE_CLIENT_KEY, (data, callback) => {
    if (trustedSillyTaverns.has(clientId)) {
      if (callback) callback({ status: 'error', message: 'Unauthorized' });
      return;
    }
    const targetClientId = data.clientId;
    try {
      Keys.removeClientKey(targetClientId);
      if (callback) callback({ status: 'ok' });
    } catch (error) {
      if (callback) callback({ status: 'error', message: error.message });
    }
  });

  socket.on('getClientList', (data, callback) => {
    if (trustedSillyTaverns.has(clientId)) {
      if (callback) callback({ status: 'error', message: 'Unauthorized' });
      return;
    }
    try {
      const clients = [];
      for (const id in Keys.getAllClientKeys()) {
        // 使用 Keys.getAllClientKeys()
        clients.push({
          id,
          description: Rooms.getClientDescription(id), // 获取客户端描述
          // rooms: Keys.getClientRooms(id), // 如果需要，可以包含客户端所属房间
        });
      }
      if (callback) callback(clients);
    } catch (error) {
      if (callback) callback({ status: 'error', message: error.message });
    }
  });

  socket.on('getClientsInRoom', (roomName, callback) => {
    try {
      const clients = io.sockets.adapter.rooms.get(roomName);
      const clientIds = clients
        ? Array.from(clients).filter((id) => id !== undefined)
        : [];

      // 获取客户端的描述信息
      const clientInfo = clientIds.map((id) => {
        const desc = Rooms.getClientDescription(id); // 从 Rooms.js 获取描述
        return { id, description: desc };
      });

      if (callback) callback(clientInfo);
    } catch (error) {
      if (callback) callback({ status: 'error', message: error.message });
    }
  });
});

// /llm 命名空间
const llmNsp = io.of(NAMESPACES.LLM);

// 用于存储请求的映射关系： { [requestId]: [ { target: string, clientId: string }, ... ] }
const llmRequests = {};

llmNsp.on('connection', socket => {
  const clientId = socket.handshake.auth.clientId;

  // 监听 LLM_REQUEST
  socket.on(MSG_TYPE.LLM_REQUEST, data => {
    console.log(`Received LLM request from ${clientId}:`, data);

    const target = data.target; // 假设 data 中始终包含 target (SillyTavern 的 clientId)
    const requestId = data.requestId;

    if (!canSendMessage(clientId, target)) {
      console.warn(`Client ${clientId} is not allowed to send messages to room ${target}.`);
      socket.emit(MSG_TYPE.ERROR, {
        type: MSG_TYPE.ERROR,
        message: `Client ${clientId} is not allowed to send messages to room ${target}.`,
      });
      return;
    }

    if (target === 'server') {
      console.warn(`LLM requests should not be sent to the server directly.`);
      socket.emit(MSG_TYPE.ERROR, {
        type: MSG_TYPE.ERROR,
        message: 'LLM requests should not be sent to the server directly.',
        requestId: data.requestId,
      });
      return;
    }

    // 存储请求的映射关系
    if (!llmRequests[requestId]) {
      llmRequests[requestId] = []; // 如果 requestId 不存在，则创建一个空数组
    }
    llmRequests[requestId].push({ target, clientId }); // 将新的映射关系添加到数组中
  });
  
  

});

setupServerStreamHandlers(io, NAMESPACES.LLM, llmRequests);
setupServerNonStreamHandlers(io, NAMESPACES.LLM, llmRequests); 

// /sillytavern 命名空间
const sillyTavernNsp = io.of(NAMESPACES.SILLY_TAVERN);
sillyTavernNsp.on('connection', (socket) => {
  const clientId = socket.handshake.auth.clientId;

  // 处理与 SillyTavern 相关的事件，例如 CLIENT_SETTINGS
  socket.on(MSG_TYPE.CLIENT_SETTINGS, clientSettings => {
    // 验证发送者是否是 SillyTavern 扩展
    if (trustedSillyTaverns.has(clientId)) {
      console.warn(`Client ${clientId} is not authorized to send CLIENT_SETTINGS.`);
      // 可以选择向发送者发送错误消息
      socket.emit(MSG_TYPE.ERROR, {
        type: MSG_TYPE.ERROR,
        message: 'Unauthorized: Only SillyTavern extension can send client settings.',
        requestId: clientSettings.requestId, // 如果有 requestId
      });
      return; // 阻止后续代码执行
    }

    console.log('Received client settings:', clientSettings);
    // reinitializeSocketIO(clientSettings); // 暂时不需要, 因为设置都在 settings.json 中
    saveServerSettings(clientSettings); // 使用传入的 clientSettings 更新并保存设置
  });

  // 可以添加其他与 SillyTavern 相关的事件处理程序
  // 例如，处理 SillyTavern 发送的命令或状态更新

  let toSendKey =null;

  // 监听 IDENTIFY_SILLYTAVERN
  socket.on(MSG_TYPE.IDENTIFY_SILLYTAVERN, async (data, callback) => {
    // data: { clientId: string }'

    if (trustedSillyTaverns.has(data.clientId)) {
      console.warn('SillyTavern master key already set. Ignoring new key and send old key.');
      if (sillyTavernkey.has(data.clientId)){
        toSendKey = sillyTavernkey.get(data.clientId);
      }
      if (callback) callback({ status: 'warning', message: 'SillyTavern already connected.', key: toSendKey }); //更严谨些
      return;
    } else{
      // 添加到可信 SillyTavern 集合
      trustedSillyTaverns.add(data.clientId);

      let SILLYTAVERN_key; // 为每个 SillyTavern 实例单独生成密钥
      if (Keys.clientKeys[socket.id]) {
        // 检查是否已存在密钥（不太可能，但以防万一）
        SILLYTAVERN_key = Keys.clientKeys[socket.id];
      } else {
        SILLYTAVERN_key = Keys.generateAndStoreClientKey(data.clientId);
      }
      //serverSettings.sillyTavernMasterKey = SILLYTAVERN_key; // 存储密钥（可选，取决于你如何使用）

      console.log(`SillyTavern identified with socket ID: ${socket.id} and clientId: ${data.clientId}`);
      saveServerSettings(serverSettings);
      //processLLMRequest();
      if (callback) callback({ status: 'ok', key: SILLYTAVERN_key });
    }
  });
});

// /function_call 命名空间
const functionCallNsp = io.of(NAMESPACES.FUNCTION_CALL);
functionCallNsp.on('connection', (socket) => {
  console.log(`Client connected to ${NAMESPACES.FUNCTION_CALL} namespace`);

  // 监听 function_call 事件
  socket.on(MSG_TYPE.FUNCTION_CALL, (data, callback) => {
    // data: { requestId: string, functionName: string, args: any[] }
    console.log(`Received function_call request:`, data);
    handleFunctionCallRequest(socket, data, callback);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected from ${NAMESPACES.FUNCTION_CALL} namespace: ${reason}`);
  });
});

// 静态文件服务
app.use('/lib', express.static(join(__dirname, '../lib')));
app.use('/dist', express.static(join(__dirname, './dist')));
app.use('/example', express.static(join(__dirname, './example')));
app.use('/example/LLM_Role_Play', express.static(join(__dirname, './example/LLM_Role_Play')));
app.use('/example/html', express.static(join(__dirname, './example/LLM_Role_Play/html')));
app.use('/example/json', express.static(join(__dirname, './example/LLM_Role_Play/json')));
app.use('/example/resource', express.static(join(__dirname, './example/LLM_Role_Play/resource')));
app.use('/resource', express.static(join(__dirname, './example/LLM_Role_Play/resource')));
app.use('/public', express.static(join(__dirname, './public')));

// 根路径和 /index.html 返回 monitor.html
app.use('/', (req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.sendFile(join(__dirname, 'example', 'monitor', 'monitor.html'));
  } else {
    next();
  }
});

// 404 处理
app.use((req, res) => {
  res.status(404).send('Not Found');
});

const SERVER_PORT = serverSettings.serverPort || 4000;
httpServer.listen(SERVER_PORT, () => {
  console.log(`Server listening on port ${SERVER_PORT}`);
  console.log(`Server monitor: http://localhost:${SERVER_PORT}`);
});
