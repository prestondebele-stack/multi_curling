// ============================================================
// CURLING NETWORK - Client-side WebSocket manager
// ============================================================

const CurlingNetwork = (() => {
    let ws = null;
    let serverUrl = null;
    let myTeam = null;
    let roomCode = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let intentionalClose = false;
    let lastPongTime = Date.now();
    let isReconnecting = false;       // Guard against parallel reconnect cycles
    let hasActiveGame = false;        // True once game_start or reconnected received

    // Event callbacks
    const callbacks = {
        onGameStart: null,
        onOpponentThrow: null,
        onOpponentSweepChange: null,
        onOpponentSweepStart: null,
        onOpponentSweepStop: null,
        onOpponentDisconnected: null,
        onOpponentReconnected: null,
        onOpponentLeft: null,
        onRematchRequested: null,
        onRematchAccepted: null,
        onRoomCreated: null,
        onRoomJoined: null,
        onRoomError: null,
        onQueueWaiting: null,
        onRoomExpired: null,
        onDisconnect: null,
        onReconnected: null,
        onReconnectFailed: null,
        onAuthSuccess: null,
        onAuthError: null,
        onProfileData: null,
        onRatingUpdate: null,
        onSecurityQuestion: null,
        onPasswordResetSuccess: null,
        onVapidKey: null,
        // Friends
        onFriendsList: null,
        onPendingRequests: null,
        onFriendRequestSent: null,
        onFriendRequestReceived: null,
        onFriendRequestAccepted: null,
        onFriendRequestDenied: null,
        onFriendRequestError: null,
        onFriendRemoved: null,
        onFriendPresence: null,
        // Game invites
        onGameInviteSent: null,
        onGameInviteReceived: null,
        onGameInviteError: null,
        onGameInviteDenied: null,
        onGameInviteCancelled: null,
        // Search
        onSearchResults: null,
        // Authoritative state
        onAuthoritativeState: null,
        // Connection verified (pong received after tab refocus)
        onConnectionVerified: null,
        // Chat
        onChatMessage: null,
    };

    function send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    function startHeartbeat() {
        stopHeartbeat();
        lastPongTime = Date.now();
        heartbeatTimer = setInterval(() => {
            // ONLY check for stale connections when the tab is VISIBLE.
            // When the tab is backgrounded, browsers throttle setInterval to
            // 60s+ which makes sinceLastPong spike even on healthy connections.
            // The server has its own generous 6-minute heartbeat — let it decide.
            if (!document.hidden) {
                const sinceLastPong = Date.now() - lastPongTime;
                if (sinceLastPong > 45000 && ws && ws.readyState === WebSocket.OPEN) {
                    console.log('[HEARTBEAT] No response for 45s (tab visible), forcing reconnect');
                    ws.close();
                    return;
                }
            }
            send({ type: 'ping' });
        }, 10000);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function handleMessage(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        switch (data.type) {
            case 'pong':
                lastPongTime = Date.now();
                // Connection verified alive — cancel any pending zombie check
                if (pongVerifyTimer) {
                    clearTimeout(pongVerifyTimer);
                    pongVerifyTimer = null;
                    // Notify game that connection is confirmed alive after refocus
                    if (callbacks.onConnectionVerified) callbacks.onConnectionVerified();
                }
                break;

            case 'room_created':
                roomCode = data.code;
                if (callbacks.onRoomCreated) callbacks.onRoomCreated({ code: data.code });
                break;

            case 'room_joined':
                roomCode = data.code;
                if (callbacks.onRoomJoined) callbacks.onRoomJoined({ code: data.code });
                break;

            case 'room_not_found':
                if (callbacks.onRoomError) callbacks.onRoomError({ error: 'Room not found', code: data.code });
                break;

            case 'room_full':
                if (callbacks.onRoomError) callbacks.onRoomError({ error: 'Room is full', code: data.code });
                break;

            case 'queue_waiting':
                if (callbacks.onQueueWaiting) callbacks.onQueueWaiting();
                break;

            case 'game_start':
                myTeam = data.yourTeam;
                if (data.roomCode) roomCode = data.roomCode;
                reconnectAttempts = 0;
                isReconnecting = false;
                hasActiveGame = true;
                if (callbacks.onGameStart) callbacks.onGameStart({ yourTeam: data.yourTeam, opponent: data.opponent || null, totalEnds: data.totalEnds || 6 });
                break;

            case 'opponent_throw':
                if (callbacks.onOpponentThrow) {
                    callbacks.onOpponentThrow({
                        aim: data.aim,
                        weight: data.weight,
                        spinDir: data.spinDir,
                        spinAmount: data.spinAmount,
                    });
                }
                break;

            case 'opponent_sweep_change':
                if (callbacks.onOpponentSweepChange) callbacks.onOpponentSweepChange({ level: data.level });
                break;

            case 'opponent_sweep_start':
                if (callbacks.onOpponentSweepStart) callbacks.onOpponentSweepStart();
                break;

            case 'opponent_sweep_stop':
                if (callbacks.onOpponentSweepStop) callbacks.onOpponentSweepStop();
                break;

            case 'chat_message':
                if (callbacks.onChatMessage) callbacks.onChatMessage(data.text, data.from);
                break;

            case 'opponent_disconnected':
                if (callbacks.onOpponentDisconnected) callbacks.onOpponentDisconnected();
                break;

            case 'opponent_reconnected':
                if (callbacks.onOpponentReconnected) callbacks.onOpponentReconnected({ opponent: data.opponent || null });
                break;

            case 'opponent_left':
                hasActiveGame = false;
                if (callbacks.onOpponentLeft) callbacks.onOpponentLeft();
                break;

            case 'rematch_requested':
                if (callbacks.onRematchRequested) callbacks.onRematchRequested();
                break;

            case 'rematch_accepted':
                myTeam = data.yourTeam;
                hasActiveGame = true;
                if (callbacks.onRematchAccepted) callbacks.onRematchAccepted({ yourTeam: data.yourTeam, opponent: data.opponent || null, totalEnds: data.totalEnds || 6 });
                break;

            case 'reconnected':
                myTeam = data.yourTeam;
                reconnectAttempts = 0;
                isReconnecting = false;
                hasActiveGame = true;
                if (callbacks.onReconnected) callbacks.onReconnected({
                    yourTeam: data.yourTeam,
                    gameSnapshot: data.gameSnapshot || null,
                    opponent: data.opponent || null,
                });
                break;

            case 'reconnect_failed':
                // Server says the room is gone or both slots are full.
                // If we have an active game, DON'T give up — retry.
                // The server may still be processing the old socket's close.
                if (hasActiveGame && reconnectAttempts < 30) {
                    console.log('[RECONNECT] Server returned reconnect_failed but game active — retrying');
                    isReconnecting = false;
                    attemptReconnect();
                } else {
                    isReconnecting = false;
                    hasActiveGame = false;
                    if (callbacks.onReconnectFailed) callbacks.onReconnectFailed();
                }
                break;

            case 'room_expired':
                if (callbacks.onRoomExpired) callbacks.onRoomExpired();
                break;

            // Auth
            case 'auth_success':
                if (callbacks.onAuthSuccess) callbacks.onAuthSuccess({
                    token: data.token,
                    username: data.username,
                    rank: data.rank || null,
                });
                break;

            case 'auth_error':
                if (callbacks.onAuthError) callbacks.onAuthError({ error: data.error });
                break;

            case 'profile_data':
                if (callbacks.onProfileData) callbacks.onProfileData({ profile: data.profile });
                break;

            case 'rating_update':
                if (callbacks.onRatingUpdate) callbacks.onRatingUpdate({ rank: data.rank });
                break;

            case 'security_question':
                if (callbacks.onSecurityQuestion) callbacks.onSecurityQuestion({ question: data.question });
                break;

            case 'password_reset_success':
                if (callbacks.onPasswordResetSuccess) callbacks.onPasswordResetSuccess();
                break;

            case 'vapid_key':
                if (callbacks.onVapidKey) callbacks.onVapidKey({ key: data.key });
                break;

            // Friends
            case 'friends_list':
                if (callbacks.onFriendsList) callbacks.onFriendsList({ friends: data.friends });
                break;
            case 'pending_requests':
                if (callbacks.onPendingRequests) callbacks.onPendingRequests({ incoming: data.incoming, outgoing: data.outgoing });
                break;
            case 'friend_request_sent':
                if (callbacks.onFriendRequestSent) callbacks.onFriendRequestSent({ username: data.username });
                break;
            case 'friend_request_received':
                if (callbacks.onFriendRequestReceived) callbacks.onFriendRequestReceived({ fromUserId: data.fromUserId, fromUsername: data.fromUsername });
                break;
            case 'friend_request_accepted':
                if (callbacks.onFriendRequestAccepted) callbacks.onFriendRequestAccepted({ userId: data.userId, username: data.username });
                break;
            case 'friend_request_denied':
                if (callbacks.onFriendRequestDenied) callbacks.onFriendRequestDenied({ userId: data.userId });
                break;
            case 'friend_request_error':
                if (callbacks.onFriendRequestError) callbacks.onFriendRequestError({ error: data.error });
                break;
            case 'friend_removed':
                if (callbacks.onFriendRemoved) callbacks.onFriendRemoved({ userId: data.userId });
                break;
            case 'friend_presence':
                if (callbacks.onFriendPresence) callbacks.onFriendPresence({ userId: data.userId, username: data.username, status: data.status });
                break;
            // Game invites
            case 'game_invite_sent':
                if (callbacks.onGameInviteSent) callbacks.onGameInviteSent({ inviteId: data.inviteId, toUsername: data.toUsername });
                break;
            case 'game_invite_received':
                if (callbacks.onGameInviteReceived) callbacks.onGameInviteReceived({ inviteId: data.inviteId, fromUserId: data.fromUserId, fromUsername: data.fromUsername, fromRank: data.fromRank });
                break;
            case 'game_invite_error':
                if (callbacks.onGameInviteError) callbacks.onGameInviteError({ error: data.error });
                break;
            case 'game_invite_denied':
                if (callbacks.onGameInviteDenied) callbacks.onGameInviteDenied({ inviteId: data.inviteId, byUsername: data.byUsername });
                break;
            case 'game_invite_cancelled':
                if (callbacks.onGameInviteCancelled) callbacks.onGameInviteCancelled({ inviteId: data.inviteId });
                break;
            // Search
            case 'search_results':
                if (callbacks.onSearchResults) callbacks.onSearchResults({ results: data.results || [] });
                break;
            // Authoritative state from thrower
            case 'authoritative_state':
                if (callbacks.onAuthoritativeState) callbacks.onAuthoritativeState(data);
                break;
        }
    }

    function attemptReconnect() {
        // Cancel any pending reconnect timer to avoid stacking
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // If we already have a healthy connection, no need to reconnect
        if (ws && ws.readyState === WebSocket.OPEN) {
            isReconnecting = false;
            return;
        }

        // If another reconnect cycle is already running, skip
        if (isReconnecting) return;

        if (!roomCode) {
            if (callbacks.onReconnectFailed) callbacks.onReconnectFailed();
            return;
        }

        // If we have an active game, NEVER give up — keep trying
        const maxAttempts = hasActiveGame ? Infinity : 30;
        if (reconnectAttempts >= maxAttempts) {
            isReconnecting = false;
            hasActiveGame = false;
            if (callbacks.onReconnectFailed) callbacks.onReconnectFailed();
            return;
        }

        isReconnecting = true;
        reconnectAttempts++;
        // Backoff: 500ms, 1s, 2s, 4s, 8s max
        const delay = Math.min(500 * Math.pow(2, reconnectAttempts - 1), 8000);

        reconnectTimer = setTimeout(() => {
            // Double-check — a different code path may have reconnected us
            if (ws && ws.readyState === WebSocket.OPEN) {
                isReconnecting = false;
                return;
            }

            let newWs;
            try {
                newWs = new WebSocket(serverUrl);
            } catch (e) {
                isReconnecting = false;
                attemptReconnect();
                return;
            }

            // Track this specific WebSocket so we can ignore stale close events
            const thisWs = newWs;

            newWs.onopen = () => {
                ws = newWs;
                ws.onmessage = handleMessage;
                ws.onclose = handleClose;
                ws.onerror = () => {};
                isReconnecting = false;
                startHeartbeat();
                // Try to rejoin room
                send({ type: 'reconnect', code: roomCode });
                // Re-auth with saved token if available
                const savedToken = localStorage.getItem('curling_token');
                if (savedToken) {
                    send({ type: 'token_login', token: savedToken });
                }
            };

            newWs.onerror = () => {
                // Don't double-trigger (onclose will also fire)
            };

            newWs.onclose = () => {
                // ONLY continue reconnecting if this WebSocket is still the current one.
                // If a newer WebSocket already took over, ignore this stale close event.
                if (thisWs !== ws && ws && ws.readyState === WebSocket.OPEN) {
                    return; // A newer connection is already working — ignore
                }
                isReconnecting = false;
                if (roomCode && !intentionalClose) {
                    attemptReconnect();
                }
            };
        }, delay);
    }

    function handleClose() {
        stopHeartbeat();

        // CRITICAL: Only start reconnect if this close event is from the CURRENT ws.
        // When we reconnect with a new WebSocket, the old one may fire its close
        // event later. We must ignore stale close events from old sockets.
        // We can't easily check identity here since ws may have been reassigned,
        // but we CAN check if we already have a working connection.
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Current connection is fine — this close event is from an old socket
            return;
        }

        if (!intentionalClose && roomCode) {
            if (callbacks.onDisconnect) callbacks.onDisconnect();
            attemptReconnect();
        }
    }

    // --- Tab visibility handling ---
    // When the tab is backgrounded, Android Chrome kills the TCP connection
    // but the JS WebSocket.readyState may still report OPEN (stale state).
    // We MUST verify the connection is truly alive by demanding a pong.
    let pongVerifyTimer = null;

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            if (pongVerifyTimer) { clearTimeout(pongVerifyTimer); pongVerifyTimer = null; }

            if (ws && ws.readyState === WebSocket.OPEN) {
                // Connection CLAIMS to be open — verify with a fast pong check.
                // If no pong in 3 seconds, the TCP pipe is dead. Force reconnect.
                lastPongTime = Date.now();
                send({ type: 'ping' });
                startHeartbeat();

                pongVerifyTimer = setTimeout(() => {
                    pongVerifyTimer = null;
                    const elapsed = Date.now() - lastPongTime;
                    if (elapsed >= 2900 && ws && ws.readyState === WebSocket.OPEN && roomCode) {
                        // No pong received — connection is zombie. Kill and reconnect.
                        console.log('[VISIBILITY] No pong in 3s after refocus — forcing reconnect');
                        ws.close();
                        reconnectAttempts = 0;
                        isReconnecting = false;
                        attemptReconnect();
                    }
                }, 3000);
            } else if (ws && ws.readyState === WebSocket.CONNECTING) {
                // Connection in progress, just wait
            } else if (roomCode && !intentionalClose) {
                // Connection was actually lost while tab was hidden — reconnect
                console.log('[VISIBILITY] Connection lost while hidden, reconnecting');
                reconnectAttempts = 0;
                isReconnecting = false; // Force allow new cycle
                attemptReconnect();
            }
        }
    });

    // Public API
    return {
        connect(url) {
            serverUrl = url;
            intentionalClose = false;

            return new Promise((resolve, reject) => {
                try {
                    ws = new WebSocket(url);
                } catch (e) {
                    reject(e);
                    return;
                }

                ws.onopen = () => {
                    reconnectAttempts = 0;
                    startHeartbeat();
                    resolve();
                };

                ws.onmessage = handleMessage;
                ws.onclose = handleClose;
                ws.onerror = () => {
                    reject(new Error('WebSocket connection failed'));
                };
            });
        },

        disconnect() {
            intentionalClose = true;
            isReconnecting = false;
            hasActiveGame = false;
            stopHeartbeat();
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (pongVerifyTimer) {
                clearTimeout(pongVerifyTimer);
                pongVerifyTimer = null;
            }
            if (ws) {
                ws.close();
                ws = null;
            }
            myTeam = null;
            roomCode = null;
            reconnectAttempts = 0;
        },

        isConnected() {
            return ws && ws.readyState === WebSocket.OPEN;
        },

        // Lobby
        createRoom(totalEnds) { send({ type: 'create_room', totalEnds: totalEnds || 6 }); },
        joinRoom(code) { send({ type: 'join_room', code: code.toUpperCase() }); },
        joinQueue() { send({ type: 'join_queue' }); },
        leaveQueue() { send({ type: 'leave_queue' }); },

        // Gameplay
        sendThrow(params) {
            send({ type: 'throw', aim: params.aim, weight: params.weight, spinDir: params.spinDir, spinAmount: params.spinAmount });
        },
        sendSweepChange(level) { send({ type: 'sweep_change', level }); },
        sendSweepStart() { send({ type: 'sweep_start' }); },
        sendSweepStop() { send({ type: 'sweep_stop' }); },
        sendTurnComplete() { send({ type: 'turn_complete' }); },
        sendRematch() { send({ type: 'rematch' }); },
        sendLeave() { send({ type: 'leave' }); },
        sendChatMessage(text) { send({ type: 'chat_message', text }); },

        // Game state sync (for reconnection)
        sendGameStateSync(snapshot) { send({ type: 'game_state_sync', snapshot }); },
        // Authoritative throw result (thrower sends after stone settles)
        sendThrowSettled(data) { send({ type: 'throw_settled', ...data }); },

        // Game over (record result)
        sendGameOver(redScore, yellowScore, endCount) {
            send({ type: 'game_over', redScore, yellowScore, endCount });
        },

        // Auth
        sendLogin(username, password) { send({ type: 'login', username, password }); },
        sendRegister(username, password, country, securityQuestion, securityAnswer, firstName, lastName) { send({ type: 'register', username, password, country, securityQuestion, securityAnswer, firstName, lastName }); },
        sendTokenLogin(token) { send({ type: 'token_login', token }); },
        sendGetProfile() { send({ type: 'get_profile' }); },
        sendGetSecurityQuestion(username) { send({ type: 'get_security_question', username }); },
        sendResetPassword(username, answer, newPassword) { send({ type: 'reset_password', username, answer, newPassword }); },
        sendGetVapidKey() { send({ type: 'get_vapid_key' }); },
        sendPushSubscribe(subscription) { send({ type: 'push_subscribe', subscription }); },
        sendPushUnsubscribe(endpoint) { send({ type: 'push_unsubscribe', endpoint }); },

        // Search
        sendSearchUsers(query) { send({ type: 'search_users', query }); },

        // Friends
        sendFriendRequest(username) { send({ type: 'send_friend_request', username }); },
        acceptFriendRequest(fromUserId) { send({ type: 'accept_friend_request', fromUserId }); },
        denyFriendRequest(fromUserId) { send({ type: 'deny_friend_request', fromUserId }); },
        removeFriend(friendId) { send({ type: 'remove_friend', friendId }); },
        getFriendsList() { send({ type: 'get_friends_list' }); },
        getPendingRequests() { send({ type: 'get_pending_requests' }); },
        sendGameInvite(toUserId) { send({ type: 'send_game_invite', toUserId }); },
        acceptGameInvite(inviteId) { send({ type: 'accept_game_invite', inviteId }); },
        denyGameInvite(inviteId) { send({ type: 'deny_game_invite', inviteId }); },
        cancelGameInvite(inviteId) { send({ type: 'cancel_game_invite', inviteId }); },

        // Event registration
        onGameStart(cb) { callbacks.onGameStart = cb; },
        onOpponentThrow(cb) { callbacks.onOpponentThrow = cb; },
        onOpponentSweepChange(cb) { callbacks.onOpponentSweepChange = cb; },
        onOpponentSweepStart(cb) { callbacks.onOpponentSweepStart = cb; },
        onOpponentSweepStop(cb) { callbacks.onOpponentSweepStop = cb; },
        onOpponentDisconnected(cb) { callbacks.onOpponentDisconnected = cb; },
        onOpponentReconnected(cb) { callbacks.onOpponentReconnected = cb; },
        onOpponentLeft(cb) { callbacks.onOpponentLeft = cb; },
        onRematchRequested(cb) { callbacks.onRematchRequested = cb; },
        onRematchAccepted(cb) { callbacks.onRematchAccepted = cb; },
        onRoomCreated(cb) { callbacks.onRoomCreated = cb; },
        onRoomJoined(cb) { callbacks.onRoomJoined = cb; },
        onRoomError(cb) { callbacks.onRoomError = cb; },
        onQueueWaiting(cb) { callbacks.onQueueWaiting = cb; },
        onRoomExpired(cb) { callbacks.onRoomExpired = cb; },
        onDisconnect(cb) { callbacks.onDisconnect = cb; },
        onReconnected(cb) { callbacks.onReconnected = cb; },
        onReconnectFailed(cb) { callbacks.onReconnectFailed = cb; },
        onAuthSuccess(cb) { callbacks.onAuthSuccess = cb; },
        onAuthError(cb) { callbacks.onAuthError = cb; },
        onProfileData(cb) { callbacks.onProfileData = cb; },
        onRatingUpdate(cb) { callbacks.onRatingUpdate = cb; },
        onSecurityQuestion(cb) { callbacks.onSecurityQuestion = cb; },
        onPasswordResetSuccess(cb) { callbacks.onPasswordResetSuccess = cb; },
        onVapidKey(cb) { callbacks.onVapidKey = cb; },
        // Friends
        onFriendsList(cb) { callbacks.onFriendsList = cb; },
        onPendingRequests(cb) { callbacks.onPendingRequests = cb; },
        onFriendRequestSent(cb) { callbacks.onFriendRequestSent = cb; },
        onFriendRequestReceived(cb) { callbacks.onFriendRequestReceived = cb; },
        onFriendRequestAccepted(cb) { callbacks.onFriendRequestAccepted = cb; },
        onFriendRequestDenied(cb) { callbacks.onFriendRequestDenied = cb; },
        onFriendRequestError(cb) { callbacks.onFriendRequestError = cb; },
        onFriendRemoved(cb) { callbacks.onFriendRemoved = cb; },
        onFriendPresence(cb) { callbacks.onFriendPresence = cb; },
        // Game invites
        onGameInviteSent(cb) { callbacks.onGameInviteSent = cb; },
        onGameInviteReceived(cb) { callbacks.onGameInviteReceived = cb; },
        onGameInviteError(cb) { callbacks.onGameInviteError = cb; },
        onGameInviteDenied(cb) { callbacks.onGameInviteDenied = cb; },
        onGameInviteCancelled(cb) { callbacks.onGameInviteCancelled = cb; },
        // Search
        onSearchResults(cb) { callbacks.onSearchResults = cb; },
        // Authoritative state
        onAuthoritativeState(cb) { callbacks.onAuthoritativeState = cb; },
        // Connection verified
        onConnectionVerified(cb) { callbacks.onConnectionVerified = cb; },
        // Chat
        onChatMessage(cb) { callbacks.onChatMessage = cb; },

        // State
        getMyTeam() { return myTeam; },
        getRoomCode() { return roomCode; },
    };
})();
