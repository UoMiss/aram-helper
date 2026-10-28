use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub struct LcuConnection {
    port: String,
    auth: String,
    client: reqwest::Client,
}

// ────── 对局原始数据 ──────

/// 玩家原始数据
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerData {
    #[serde(default)]
    pub participant_id: i64,
    pub summoner_name: String,
    pub champion_id: i64,
    #[serde(default)]
    pub team_id: Option<i64>,
    pub damage: i64,
    pub damage_taken: i64,
    pub gold_earned: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub is_friend: bool,
    pub is_me: bool,
    #[serde(default)]
    pub is_history_owner: bool,
}

/// 对局原始数据（由前端选择参与者和分组）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameResult {
    pub game_id: i64,
    pub game_mode: String,
    #[serde(default)]
    pub is_custom_game: Option<bool>,
    pub game_duration: i64,
    pub timestamp: i64,
    pub players: Vec<PlayerData>, // 双方玩家；前端根据模式分组
    #[serde(default)]
    pub history_owner_puuid: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FriendSummary {
    pub puuid: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub game_id: i64,
    pub game_mode: String,
    pub game_duration: i64,
    pub timestamp: i64,
    pub champion_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveGame {
    pub game_id: i64,
    pub phase: String,
}

// ────── LCU 连接 ──────

impl LcuConnection {
    pub async fn connect() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let (port, token) = Self::find_credentials()?;
        Self::from_credentials(port, token).await
    }

    /// 用已知凭证创建连接（跳过检测，直接连）
    pub async fn from_credentials(port: String, token: String) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let auth = base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", token));
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            // LCU 仅连接本机，避免系统代理影响；请求超时后交由前端重连。
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(5))
            .build()?;
        Ok(Self { port, auth, client })
    }

    /// 获取当前凭证（用于缓存）
    pub fn credentials(&self) -> (String, String) {
        // 从 auth 反解 token
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&self.auth)
            .unwrap_or_default();
        let s = String::from_utf8_lossy(&decoded);
        let token = s.strip_prefix("riot:").unwrap_or("").to_string();
        (self.port.clone(), token)
    }

    fn find_credentials() -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "windows")]
        {
            let mut errors = Vec::new();
            match Self::from_wmic() {
                Ok(r) => return Ok(r),
                Err(e) => errors.push(format!("wmic: {}", e)),
            }
            match Self::from_powershell_cim() {
                Ok(r) => return Ok(r),
                Err(e) => errors.push(format!("powershell: {}", e)),
            }
            match Self::from_process_lockfile() {
                Ok(r) => return Ok(r),
                Err(e) => errors.push(format!("lockfile: {}", e)),
            }
            return Err(format!("所有检测方式均失败:\n{}", errors.join("\n")).into());
        }
        #[cfg(not(target_os = "windows"))]
        Err("仅支持 Windows 系统".into())
    }

    #[cfg(target_os = "windows")]
    fn extract_port_token(text: &str) -> Option<(String, String)> {
        let port = text.find("--app-port=").and_then(|i| {
            let s = i + 11;
            let e = text[s..].find(|c: char| !c.is_ascii_digit()).map(|j| s + j).unwrap_or(text.len());
            let p = text[s..e].to_string();
            if p.is_empty() { None } else { Some(p) }
        })?;
        let token = text.find("--remoting-auth-token=").and_then(|i| {
            let s = i + 22;
            let e = text[s..].find(|c: char| !c.is_alphanumeric() && c != '-' && c != '_').map(|j| s + j).unwrap_or(text.len());
            let t = text[s..e].to_string();
            if t.is_empty() { None } else { Some(t) }
        })?;
        Some((port, token))
    }

    #[cfg(target_os = "windows")]
    fn from_wmic() -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let out = Command::new("cmd")
            .args(["/C", "wmic process where \"name='LeagueClientUx.exe'\" get CommandLine /value"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW，隐藏终端黑窗
            .output()?;
        let s = String::from_utf8_lossy(&out.stdout);
        if s.trim().is_empty() { return Err("未找到 LeagueClientUx.exe".into()); }
        Self::extract_port_token(&s).ok_or_else(|| "命令行中未找到 port/token".into())
    }

    #[cfg(target_os = "windows")]
    fn from_powershell_cim() -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\").CommandLine"])
            .creation_flags(0x08000000)
            .output()?;
        let s = String::from_utf8_lossy(&out.stdout);
        if s.trim().is_empty() { return Err("未找到 LeagueClientUx.exe".into()); }
        Self::extract_port_token(&s).ok_or_else(|| "命令行中未找到 port/token".into())
    }

    #[cfg(target_os = "windows")]
    fn from_process_lockfile() -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let out = Command::new("cmd")
            .args(["/C", "wmic process where \"name='LeagueClientUx.exe'\" get ExecutablePath /value"])
            .creation_flags(0x08000000)
            .output()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let path = s.lines()
            .find(|l| l.starts_with("ExecutablePath="))
            .map(|l| l.trim_start_matches("ExecutablePath=").trim().to_string())
            .unwrap_or_default();
        if path.is_empty() {
            let out = Command::new("powershell")
                .args(["-NoProfile", "-Command", "(Get-Process LeagueClientUx -ErrorAction SilentlyContinue).Path"])
                .creation_flags(0x08000000)
                .output()?;
            let ps = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if ps.is_empty() { return Err("无法获取进程路径".into()); }
            return Self::read_lockfile_from_exe(&ps);
        }
        Self::read_lockfile_from_exe(&path)
    }

    #[cfg(target_os = "windows")]
    fn read_lockfile_from_exe(exe: &str) -> Result<(String, String), Box<dyn std::error::Error + Send + Sync>> {
        let dir = std::path::Path::new(exe).parent().ok_or("无法获取目录")?;
        let content = std::fs::read_to_string(dir.join("lockfile"))
            .map_err(|e| format!("lockfile: {}", e))?;
        let parts: Vec<&str> = content.trim().split(':').collect();
        if parts.len() >= 4 { Ok((parts[2].to_string(), parts[3].to_string())) }
        else { Err("lockfile 格式异常".into()) }
    }

    // ────── API 调用 ──────

    async fn api(&self, path: &str) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("https://127.0.0.1:{}{}", self.port, path);
        let res = self.client.get(&url)
            .header("Authorization", format!("Basic {}", self.auth))
            .send().await?;
        if !res.status().is_success() {
            return Err(format!("API {} 返回 {}", path, res.status()).into());
        }
        Ok(res.json().await?)
    }

    pub async fn get_current_summoner(&self) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let data = self.api("/lol-summoner/v1/current-summoner").await?;
        Ok(data["displayName"].as_str().unwrap_or("未知").to_string())
    }

    pub async fn get_gameflow_phase(&self) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let data = self.api("/lol-gameflow/v1/gameflow-phase").await?;
        Ok(data.as_str().unwrap_or("None").to_string())
    }

    /// 当前会话的类型仅用于状态展示；历史结算独立读取自身类型。
    pub async fn get_current_game_type(&self) -> Result<Option<bool>, Box<dyn std::error::Error + Send + Sync>> {
        let session = self.api("/lol-gameflow/v1/session").await?;
        if session["phase"].as_str() == Some("None") { return Ok(None); }
        Ok(session["gameData"]["isCustomGame"].as_bool()
            .or_else(|| session["gameData"]["queue"]["isCustom"].as_bool()))
    }

    async fn resolve_result_game_type(&self, details: &serde_json::Value) -> Option<bool> {
        match details["gameType"].as_str() {
            Some("CUSTOM_GAME") => return Some(true),
            Some("MATCHED_GAME") => return Some(false),
            // 教学等特殊类型不参与红包结算。
            Some(kind) if !kind.is_empty() => return None,
            _ => {}
        }
        let queue_id = details["queueId"].as_i64().filter(|id| *id >= 0)?;
        // 缺少 gameType 时向客户端查询队列，不能把未知编号当作匹配。
        self.api(&format!("/lol-game-queues/v1/queues/{}/isCustom", queue_id))
            .await.ok()?.as_bool()
    }

    /// 使用同一会话快照读取阶段和编号；结算阶段可用于恢复本局，前端不会补设规则。
    pub async fn get_active_game(&self) -> Result<Option<ActiveGame>, Box<dyn std::error::Error + Send + Sync>> {
        let session = self.api("/lol-gameflow/v1/session").await?;
        let phase = session["phase"].as_str().unwrap_or("");
        if !matches!(phase, "GameStart" | "InProgress" | "Reconnect" | "WaitingForStats" | "PreEndOfGame" | "EndOfGame") { return Ok(None); }
        let game_id = session["gameData"]["gameId"].as_i64().filter(|id| *id > 0)
            .ok_or("本局对局编号尚未就绪")?;
        Ok(Some(ActiveGame { game_id, phase: phase.to_string() }))
    }

    /// 好友选择使用完整列表；读取失败必须显式报错，不能伪装为空名单。
    pub async fn get_friends(&self) -> Result<Vec<FriendSummary>, Box<dyn std::error::Error + Send + Sync>> {
        let data = self.api("/lol-chat/v1/friends").await?;
        let items = data.as_array().ok_or("好友列表格式不完整")?;
        let mut seen = HashSet::new();
        let mut friends = Vec::new();
        for item in items {
            let Some(puuid) = item["puuid"].as_str().filter(|id| !id.is_empty()) else { continue; };
            if !seen.insert(puuid.to_string()) { continue; }
            let name = item["gameName"].as_str().filter(|name| !name.is_empty())
                .or_else(|| item["name"].as_str().filter(|name| !name.is_empty())).unwrap_or("未命名好友");
            let tag = item["gameTag"].as_str().filter(|tag| !tag.is_empty());
            friends.push(FriendSummary { puuid: puuid.to_string(),
                display_name: tag.map(|tag| format!("{}#{}", name, tag)).unwrap_or_else(|| name.to_string()) });
        }
        friends.sort_by(|a, b| a.display_name.cmp(&b.display_name).then(a.puuid.cmp(&b.puuid)));
        Ok(friends)
    }

    async fn checked_friend_ids(&self, puuid: &str) -> Result<HashSet<String>, Box<dyn std::error::Error + Send + Sync>> {
        if puuid.is_empty() || puuid.len() > 128 || !puuid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
            return Err("好友标识无效，请刷新好友列表".into());
        }
        let ids: HashSet<String> = self.get_friends().await?.into_iter().map(|friend| friend.puuid).collect();
        if !ids.contains(puuid) { return Err("该玩家已不在好友列表，请刷新后重选".into()); }
        Ok(ids)
    }

    pub async fn get_friend_match_list(&self, puuid: &str, count: usize) -> Result<Vec<MatchSummary>, Box<dyn std::error::Error + Send + Sync>> {
        self.checked_friend_ids(puuid).await?;
        self.read_match_list(puuid, count).await
    }

    async fn get_friend_puuids(&self) -> HashSet<String> {
        self.api("/lol-chat/v1/friends").await
            .map(|data| {
                data.as_array().unwrap_or(&vec![]).iter()
                    .filter_map(|f| f["puuid"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 获取最近 N 局的概要列表
    pub async fn get_match_list(&self, count: usize) -> Result<Vec<MatchSummary>, Box<dyn std::error::Error + Send + Sync>> {
        let summoner = self.api("/lol-summoner/v1/current-summoner").await?;
        let puuid = summoner["puuid"].as_str().ok_or("无法获取 PUUID")?;

        self.read_match_list(puuid, count).await
    }

    async fn read_match_list(&self, puuid: &str, count: usize) -> Result<Vec<MatchSummary>, Box<dyn std::error::Error + Send + Sync>> {
        let history = self.api(
            &format!("/lol-match-history/v1/products/lol/{}/matches?begIndex=0&endIndex={}", puuid, count)
        ).await?;

        let games = history["games"]["games"].as_array().ok_or("无对局记录")?;

        let mut list = Vec::new();
        for game in games {
            // 找到当前玩家使用的英雄
            let my_champion = Self::find_my_champion(game, puuid);
            list.push(MatchSummary {
                game_id: game["gameId"].as_i64().unwrap_or(0),
                game_mode: game["gameMode"].as_str().unwrap_or("").to_string(),
                game_duration: game["gameDuration"].as_i64().unwrap_or(0),
                timestamp: game["gameCreation"].as_i64().unwrap_or(0),
                champion_id: my_champion,
            });
        }

        Ok(list)
    }

    fn find_my_champion(game: &serde_json::Value, puuid: &str) -> i64 {
        let identities = game["participantIdentities"].as_array();
        let participants = game["participants"].as_array();

        if let (Some(ids), Some(parts)) = (identities, participants) {
            for id in ids {
                if id["player"]["puuid"].as_str() == Some(puuid) {
                    let pid = id["participantId"].as_i64().unwrap_or(0);
                    for p in parts {
                        if p["participantId"].as_i64() == Some(pid) {
                            return p["championId"].as_i64().unwrap_or(0);
                        }
                    }
                }
            }
        }
        0
    }

    /// 获取指定对局的双方玩家原始数据
    pub async fn get_game_result(&self, game_id: i64) -> Result<GameResult, Box<dyn std::error::Error + Send + Sync>> {
        let summoner = self.api("/lol-summoner/v1/current-summoner").await?;
        let my_puuid = summoner["puuid"].as_str().ok_or("无法获取 PUUID")?.to_string();

        let friend_puuids = self.get_friend_puuids().await;
        self.read_game_result(game_id, &my_puuid, None, &friend_puuids).await
    }

    pub async fn get_friend_game_result(&self, game_id: i64, puuid: &str) -> Result<GameResult, Box<dyn std::error::Error + Send + Sync>> {
        let friend_puuids = self.checked_friend_ids(puuid).await?;
        let summoner = self.api("/lol-summoner/v1/current-summoner").await?;
        let my_puuid = summoner["puuid"].as_str().ok_or("无法获取当前玩家 PUUID")?;
        self.read_game_result(game_id, my_puuid, Some(puuid), &friend_puuids).await
    }

    async fn read_game_result(&self, game_id: i64, my_puuid: &str, history_owner: Option<&str>, friend_puuids: &HashSet<String>) -> Result<GameResult, Box<dyn std::error::Error + Send + Sync>> {
        let details = self.api(&format!("/lol-match-history/v1/games/{}", game_id)).await?;

        if details["gameId"].as_i64() != Some(game_id) {
            return Err("对局数据编号不一致，等待本局战绩生成".into());
        }

        let game_mode = details["gameMode"].as_str().unwrap_or("").to_string();
        let is_custom_game = self.resolve_result_game_type(&details).await;
        let game_duration = details["gameDuration"].as_i64().unwrap_or(0);
        let timestamp = details["gameCreation"].as_i64().unwrap_or(0);

        let participants = details["participants"].as_array().ok_or("无参与者数据")?;
        let identities = details["participantIdentities"].as_array().ok_or("无身份数据")?;

        // 构建映射
        let mut name_map: HashMap<i64, String> = HashMap::new();
        let mut puuid_map: HashMap<i64, String> = HashMap::new();
        for id in identities {
            let pid = id["participantId"].as_i64().unwrap_or(0);
            let name = id["player"]["gameName"].as_str()
                .or_else(|| id["player"]["summonerName"].as_str())
                .unwrap_or("未知")
                .to_string();
            name_map.insert(pid, name);
            puuid_map.insert(pid, id["player"]["puuid"].as_str().unwrap_or("").to_string());
        }

        // 保存双方玩家与阵营，让分组模式独立选择参与者。
        let required_player = history_owner.unwrap_or(my_puuid);
        if !puuid_map.values().any(|v| v == required_player) {
            return Err("对局中未找到所选玩家，请重新读取战绩".into());
        }
        let mut team: Vec<&serde_json::Value> = participants.iter().collect();
        team.sort_by_key(|p| p["participantId"].as_i64().unwrap_or(0));

        let players: Result<Vec<PlayerData>, &'static str> = team.iter().map(|p| {
            let pid = p["participantId"].as_i64().unwrap_or(0);
            let player_puuid = puuid_map.get(&pid).cloned().unwrap_or_default();
            let champion_id = p["championId"].as_i64().unwrap_or(0);
            let is_me = player_puuid == my_puuid;

            Ok(PlayerData {
                participant_id: pid,
                summoner_name: name_map.get(&pid).cloned().unwrap_or("未知".to_string()),
                champion_id,
                team_id: p["teamId"].as_i64(),
                damage: p["stats"]["totalDamageDealtToChampions"].as_i64().filter(|value| *value >= 0).ok_or("对英雄伤害数据不完整，请稍后重新读取")?,
                damage_taken: p["stats"]["totalDamageTaken"].as_i64().unwrap_or(0),
                gold_earned: p["stats"]["goldEarned"].as_i64().unwrap_or(0),
                kills: p["stats"]["kills"].as_i64().unwrap_or(0),
                deaths: p["stats"]["deaths"].as_i64().unwrap_or(0),
                assists: p["stats"]["assists"].as_i64().unwrap_or(0),
                is_friend: is_me || friend_puuids.contains(&player_puuid),
                is_me,
                is_history_owner: history_owner == Some(player_puuid.as_str()),
            })
        }).collect();

        Ok(GameResult {
            game_id,
            game_mode,
            is_custom_game,
            game_duration,
            timestamp,
            players: players?,
            history_owner_puuid: history_owner.map(String::from),
        })
    }

    /// 获取最近一局的原始数据
    pub async fn get_last_game_result(&self) -> Result<GameResult, Box<dyn std::error::Error + Send + Sync>> {
        let summoner = self.api("/lol-summoner/v1/current-summoner").await?;
        let puuid = summoner["puuid"].as_str().ok_or("无法获取 PUUID")?;

        let history = self.api(
            &format!("/lol-match-history/v1/products/lol/{}/matches?begIndex=0&endIndex=1", puuid)
        ).await?;

        let game_id = history["games"]["games"][0]["gameId"]
            .as_i64()
            .ok_or("没有找到最近的对局记录")?;

        self.get_game_result(game_id).await
    }
}
