import express, { Request, Response } from "express";
import { ON_FORCE_MATCH, redisClient, redisGameServerInstanceReady, redisGetPlayer, redisGetPlayerRiftsData, redisOnGameplayConfigNotified, RedisPlayer, RedisRifts, redisUpdateMatch, redisUpdatePlayerLoadout, redisUpdatePlayerRiftsData } from "../config/redis";
import env from "../env/env";
import { PerkPagesModel } from "../database/PerkPages";
import { Types } from "mongoose";
import { changeLobbyMode, createLobby, LOBBY_MODES } from "../services/lobbyService";
import { MVSTime } from "../utils/date";
import { PlayerTesterModel } from "../database/PlayerTester";
import { getRiftChapter, RiftsDefMatchData, RiftsDefStage, RiftsDefTeam } from "../data/rifts";
import ObjectID from "bson-objectid";
import { randomBytes } from "crypto";

interface Lock_Lobby_Loadout_REQ {
  AutoPartyPreference: boolean;
  CrossplayPreference: number;
  GameplayPreferences: number;
  HissCrc: number;
  Loadout: Loadout;
  LobbyId: string;
  LobbyTemplate: string;
  Platform: string;
  Version: string;
}

interface Loadout {
  Character: string;
  Skin: string;
}

export interface Lock_Lobby_Loadout_RES {
  body: Lock_Lobby_Loadout_RES_BODY;
  metadata: any;
  return_code: number;
}

export interface Lock_Lobby_Loadout_RES_BODY {
  AccountId: string;
  Loadout: Loadout;
  bAreAllLoadoutsLocked: boolean;
}

export async function set_lock_lobby_loadout(req: Request, res: Response<Lock_Lobby_Loadout_RES>) {
  const account = req.token;
  const body = req.body as Lock_Lobby_Loadout_REQ;
  let ip = req.ip!.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1") {
    ip = env.LOCAL_PUBLIC_IP;
  }
  await redisUpdatePlayerLoadout(account.id, { character: body.Loadout.Character, skin: body.Loadout.Skin, ip: ip } as RedisPlayer);

  try {
    const updatedDoc = await PlayerTesterModel.findOneAndUpdate(
      { _id: new Types.ObjectId(account.id) },
      {
        $set: {
          character: body.Loadout.Character,
          variant: body.Loadout.Skin,
        },
      },
    ).exec();
  } catch (err) {
    console.log("Error saving Character and variant last used", err);
  }

  res.send({
    body: {
      AccountId: account.id,
      Loadout: {
        Character: body.Loadout.Character,
        Skin: body.Loadout.Skin,
      },
      bAreAllLoadoutsLocked: true,
    },
    metadata: null,
    return_code: 0,
  });
}

export interface PERKS_ABSENT_RES {
  body: PERKS_ABSENT_RES_BODY;
  metadata: any;
  return_code: number;
}

export interface PERKS_ABSENT_RES_BODY {
  message: string;
}

export async function set_perks_absent(req: Request, res: Response<PERKS_ABSENT_RES>) {
  res.send({
    body: {
      message: "Early absent report",
    },
    metadata: null,
    return_code: 2,
  });
}

export async function perks_set_page(req: Request, res: Response) {
  const { Character, Description, DisplayName, PageIndex, Perks } = req.body;
  const account_id = req.token.id; // Assuming this is an ObjectId or convertible

  // Build the update path for this page
  const pageKey = `perk_pages.${Character}.${PageIndex}`;
  const updateValue = {
    DisplayName,
    Description,
    Perks,
  };
  // 2. Upsert the specific character/page index
  try {
    const updatedDoc = await PerkPagesModel.findOneAndUpdate(
      { account_id: new Types.ObjectId(account_id) },
      {
        $set: {
          [pageKey]: updateValue,
        },
      },
      { upsert: true, new: true },
    ).exec();
  } catch (err) {
    console.log("Error saving perks", err);
  }

  res.send({
    body: {},
    metadata: null,
    return_code: 0,
  });
}

export async function handleSsc_invoke_create_party_lobby(req: Request<{}, {}, {}, {}>, res: Response) {
  const account = req.token;
  const settings:any = req.body;

  let character = "";
  let variant = "";
  let profileIcon = "";

  const playerData = await PlayerTesterModel.findOne({ _id: new Types.ObjectId(account.id) });
  //let profileicon = ""
  if (playerData) {
    character = playerData.character;
    variant = playerData?.variant;
    profileIcon = playerData?.profile_icon;
  }

  const loadout = { Character: character, Skin: variant };

  let ip = req.ip!.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1") {
    ip = env.LOCAL_PUBLIC_IP;
  }
  const lobbyMode = LOBBY_MODES.ONE_V_ONE; // Default mode, can be changed later;
  const newLobby = await createLobby(account.id, lobbyMode);

  await redisUpdatePlayerLoadout(account.id, { character: character, skin: variant, ip: ip, profileIcon: profileIcon } as RedisPlayer);
  res.send({
    body: {
      lobby: {
        Teams: [
          {
            TeamIndex: 0,
            Players: {
              [account.id]: {
                Account: { id: account.id },
                JoinedAt: { _hydra_unix_date: MVSTime(new Date()) },
                BotSettingSlug: "",
                LobbyPlayerIndex: 0,
                CrossplayPreference: 1,
              },
            },
            Length: 1,
          },
          { TeamIndex: 1, Players: {}, Length: 0 },
          { TeamIndex: 2, Players: {}, Length: 0 },
          { TeamIndex: 3, Players: {}, Length: 0 },
          { TeamIndex: 4, Players: {}, Length: 0 },
        ],
        LeaderID: account.id,
        LobbyType: 0,
        ReadyPlayers: {},
        PlayerGameplayPreferences: { [account.id]: settings.GameplayPreferences },
        PlayerAutoPartyPreferences: { [account.id]: settings.AutoPartyPreference },
        GameVersion: env.GAME_VERSION,
        HissCrc: settings.HissCrc,
        Platforms: { [account.id]: settings.Platform },
        AllMultiplayParams: settings.AllMultiplayParams,
        LockedLoadouts: { [account.id]: { Character: loadout.Character, Skin: loadout.Skin } },
        ModeString: lobbyMode.toString(),
        IsLobbyJoinable: true,
        MatchID: newLobby.id,
      },
      Cluster: "ec2-us-east-1-dokken",
    },
    metadata: null,
    return_code: 0,
  });
}


//CHARACTER GUESSER DATA
const CHARACTERS_guess = {
  "c001":"character_wonder_woman", //c007
  "c002":"character_shaggy", //c002
  "c003":"character_superman", //c003
  "C003":"character_superman", //c003
  "c004":"character_batman", //c004
  "c005":"character_jake", //c005
  "c006":"character_arya", //c006
  "c007":"character_bugs_bunny", //c001
  "c008":"character_harley", //c008
  "C008":"character_harley", //c008
  "c009":"character_creature", //raindog c009
  "c010":"character_tom_and_jerry", //c010
  "c011":"character_steven",//c011
  "c012":"character_garnet",//c012
  "c013":"character_finn",//c013
  "c014":"character_velma",//c014
  "c015":"character_taz",//c015
  "banana":"character_BananaGuard", //c034 banana
  "c034":"character_BananaGuard", //c034 banana
  "c035":"character_Jason", //c035
} as any;

//here we guess wich character is supposed to be in each rift node
//almost all of them are in their code name, but there are some exceptions
function character_guesser(text: string){
  text = text.toLowerCase();//to eliminate some "case" inconsistencies
  //text EXCEPTIONS
  if (text == "shaggy_charset"){ text = "character_set_c002_basic";}
  if (text == "batman_charset"){ text = "character_set_c004_basic";}
  if (text == "characterset_bananaguard_halloween"){ text = "character_set_c034_s02";}

  //here we split the character_set text into parts, so we can guess the character and the skin of the enemy bot
  let character_split = text.split("et_")[1].split("_")[0];
  const SSS = text.split("et_")[1].split("_"); //skin split section
  let skin_split = SSS[SSS.length-1];
  
  //guess skin by text patterns
  if (skin_split == "singleskin"){ skin_split = SSS[SSS.length-2]; }
  if (skin_split == "skin"){ skin_split = SSS[SSS.length-3]; }
  if (skin_split == "basic"){ skin_split = "default"; } else {
    skin_split = skin_split[0] + skin_split[skin_split.length-2] + skin_split[skin_split.length-1];
  }

  //character_split EXCEPTIONS
  if (character_split.includes("season")){
    const CSS = text.split("et_")[1].split("_").length;
    character_split = text.split("et_")[1].split("_")[CSS-2];
  }
  let skin = "skin_"+character_split+"_"+skin_split; //default skin text format

  //for some characters, the code name wont work, so, we guess
  for (const keys of Object.keys(CHARACTERS_guess)){
    if (keys == character_split){
      character_split = String((CHARACTERS_guess[keys] as string).split("ter_")[1]);
    }
  }
  const character = "character_"+character_split; //default character text format
  
  //for almost all the default skins, the code name of the character wont work
  //so, we use the guess variant instead.. if there is one
  if(skin_split == "default"){
    skin = "skin_"+character_split+"_"+skin_split;
  //skin EXCEPTIONS
    if (character_split == "c017"){ skin = "skin_iron_giant_default"; }
    if (character_split == "Jason"){ skin = "skin_Jason_000"; }
    if (character_split == "c036"){ skin = "skin_c036"; }
  }
  if (character_split == "jake" && skin_split == "s06"){ skin = "skin_jake_RandyButternubs"; }

  //finally, we return both character and skin for the enemy bot
  return {
    character: character,
    skin: skin
  }
}

export interface BODY_SETTINGS {
  GameplayPreferences: string;
  AutoPartyPreference: string;
  HissCrc: number;
  Platform: string;
  AllMultiplayParams: string[];
  RiftConfigSlug: string;
  ChapterGuid: string;
  ChapterDifficulty: number;
}

type bot_body = {
  AccountId: string,
  Character: string,
  Skin: string,
  Banner: string,
  ProfileIcon: string,
  RingOutVfx: string,
  StartingDamage: number
};

//let storeMatch:any = {}; //just for test: save all rift stuff

function gather_rift_data(rift_name:string){
  let RuntimeNodeData: any = {}; //here goes all the rifts data

  const chapters = getRiftChapter(rift_name) as any; //here we get all the data by it's rift code name
  //we do this for each chapter in the rift node
  for (const chapter in chapters){
    const team_info = (chapters[chapter] as unknown as RiftsDefStage).MatchData as RiftsDefMatchData;
    const enemy_team_info = team_info.EnemyTeams as any;
    const friendly_team_info = team_info.FriendlyTeam as any;
    let botNum = 0;
    let E_Stocks = 0;

    //enemies data
    let enemy_loadout: any[] = [];
    if ((enemy_team_info as string[]).length != 0){
      const teamBots = (enemy_team_info[0] as RiftsDefTeam).Bots as any;
      E_Stocks = (enemy_team_info[0] as RiftsDefTeam).NumStocks;
      for (const team of teamBots){
        const CI = character_guesser(team.CharacterSet); //set character and skin by its character_set data
        const bot: bot_body = {
          AccountId: "bot"+botNum,
          Character: CI.character,
          Skin: CI.skin,
          Banner: team.Banner,
          ProfileIcon: team.ProfileIcon,
          RingOutVfx: team.RingOutVfx,
          StartingDamage: 0
        };
        enemy_loadout[botNum] = bot;
        botNum++;
      };
    };

    //ally data (TODO:: should be ignored when in party of two)
    let friend_loadout: any[] = [];
    if ((friendly_team_info as string[]).length != 0){
      const teamBots = (friendly_team_info as RiftsDefTeam).Bots as any;
      for (const team of teamBots){
        //console.log("ALLY_BOT",botNum);
        //console.log(team);
        const CI = character_guesser(team.CharacterSet);
        const bot: bot_body = {
          AccountId: "bot"+botNum,
          Character: CI.character,
          Skin: CI.skin,
          Banner: team.Banner,
          ProfileIcon: team.ProfileIcon,
          RingOutVfx: team.RingOutVfx,
          StartingDamage: 0
        };
        friend_loadout[0] = bot;
        botNum++;
      };
    };


    //here we add the chapter's info to the NodeData object
    RuntimeNodeData[chapter] = {
      EnemyTeams:[{
        BotLoadouts: enemy_loadout,
        Stocks: E_Stocks,
        LastKnownConfiguredStocks: E_Stocks,
      }],
      FriendlyTeam:{
        BotLoadouts: friend_loadout,
      },
      Attunement: team_info.Attunement,
      CountdownDisplay: team_info.CountdownDisplay,
      Map: team_info.Map,
      bAllowMapHazards : team_info.bAllowMapHazards
    }
  }

  return RuntimeNodeData;
}

//Function to enable all rift nodes
function gather_chapter_CodeNames(rift_name:string){
  let CodeNames: any[] = []; //here goes all the rifts chapter names
  const chapters = getRiftChapter(rift_name) as any; //here we get all the data by it's rift code name
  for (const chapter in chapters){
    CodeNames.push(chapter);
  }

  return CodeNames;
}

//RIFT LOBBY
//here we load all the rifts data into the game
export async function handleSsc_invoke_create_rift_lobby(req: Request<{}, {}, {}, {}>, res: Response) {
  const settings = req.body as BODY_SETTINGS;
  const account = req.token;

  //server stuff
  let ip = req.ip!.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1") {
    ip = env.LOCAL_PUBLIC_IP;
  }
  const lobbyMode = LOBBY_MODES.RIFTS;
  const newLobby = await createLobby(account.id, lobbyMode);

  await redisUpdatePlayerRiftsData(account.id, {
    riftChapter: settings.RiftConfigSlug
  } as RedisRifts);

  try{
    res.send({
      "body": {
        "lobby": {
          "Teams": [
            {
              "TeamIndex": 0,
              "Players": {
                  [account.id]: {
                      "Account": { "id": account.id },
                      "JoinedAt": MVSTime(new Date()),
                      "BotSettingSlug": "",
                      "LobbyPlayerIndex": 0,
                      "CrossplayPreference": 1
                  }
              },
              "Length": 1
            },
            { "TeamIndex": 1, "Players": {}, "Length": 0 },
            { "TeamIndex": 2, "Players": {}, "Length": 0 },
            { "TeamIndex": 3, "Players": {}, "Length": 0 },
            { "TeamIndex": 4, "Players": {}, "Length": 0 }
          ],
          "LeaderID": account.id,
          "LobbyType": 0,
          "ReadyPlayers": {},
          "PlayerGameplayPreferences": {
            [account.id]: settings.GameplayPreferences
          },
          "PlayerAutoPartyPreferences": {
            [account.id]: settings.AutoPartyPreference
          },
          "GameVersion": "CLIENT:2F322-Retail DATA:4CF442B2 PERKS:1",
          "HissCrc": settings.HissCrc,
          "Platforms": {
            [account.id]: settings.Platform
          },
          "AllMultiplayParams": settings.AllMultiplayParams,
          "RiftConfigSlug": settings.RiftConfigSlug,
          "ChapterGuid": settings.ChapterGuid,
          "IsLobbyJoinable": true,
          "RuntimeData": {
            "RuntimeChapterData": {
              [settings.ChapterGuid]: {
                "bIsChapterComplete": false,
                "NodeCompletionsByDifficulty": {
                  "0": gather_chapter_CodeNames(settings.RiftConfigSlug),
                  "1": [],
                  "2": [],
                  "3": []
                },
                "CurrentDifficulty": 0, //CANT UPDATE THE DIFICULTY, IT CRASHES THE GAME
                "HighestDifficultyCompleted": 3
              }
            },
            "RuntimeNodeData": gather_rift_data(settings.RiftConfigSlug), //Here goes all the rift's data we gather before
          },
          "RiftState": {},
          "bNeverJoinable": false,
          "MatchID": newLobby.id,
        },
        "Cluster": "ec2-us-east-1-dokken"
      },
      "metadata": null,
      "return_code": 0
    });
  } catch(error){
    console.log(`Error?: ${error}`);
  }
}


export async function handleSsc_invoke_switch_rift_chapters(req: Request<{}, {}, {}, {}>, res: Response) {
  const settings = req.body as BODY_SETTINGS;
  const account = req.token;

  //server stuff
  let ip = req.ip!.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1") {
    ip = env.LOCAL_PUBLIC_IP;
  }
  let MatchID = "";

  await redisUpdatePlayerRiftsData(account.id, {
    riftChapter: settings.RiftConfigSlug
  } as RedisRifts);
  const playerRiftsData = await redisGetPlayerRiftsData(account.id) as RedisRifts;
  if (playerRiftsData){
    MatchID += playerRiftsData.riftLobbyId as string;
  }

  try{
    res.send({
      "body": {
        "lobby": {
          "Teams": [
            {
              "TeamIndex": 0,
              "Players": {
                  [account.id]: {
                      "Account": { "id": account.id },
                      "JoinedAt": MVSTime(new Date()),
                      "BotSettingSlug": "",
                      "LobbyPlayerIndex": 0,
                      "CrossplayPreference": 1
                  }
              },
              "Length": 1
            },
            { "TeamIndex": 1, "Players": {}, "Length": 0 },
            { "TeamIndex": 2, "Players": {}, "Length": 0 },
            { "TeamIndex": 3, "Players": {}, "Length": 0 },
            { "TeamIndex": 4, "Players": {}, "Length": 0 }
          ],
          "LeaderID": account.id,
          "LobbyType": 0,
          "ReadyPlayers": {},
          "PlayerGameplayPreferences": {
            [account.id]: settings.GameplayPreferences
          },
          "PlayerAutoPartyPreferences": {
            [account.id]: settings.AutoPartyPreference
          },
          "GameVersion": "CLIENT:2F322-Retail DATA:4CF442B2 PERKS:1",
          "HissCrc": settings.HissCrc,
          "Platforms": {
            [account.id]: settings.Platform
          },
          "AllMultiplayParams": settings.AllMultiplayParams,
          "RiftConfigSlug": settings.RiftConfigSlug,
          "ChapterGuid": settings.ChapterGuid,
          "IsLobbyJoinable": true,
          "RuntimeData": {
            "RuntimeChapterData": {
              [settings.ChapterGuid]: {
                "bIsChapterComplete": false,
                "NodeCompletionsByDifficulty": {
                  "0": gather_chapter_CodeNames(settings.RiftConfigSlug),
                  "1": [],
                  "2": [],
                  "3": []
                },
                "CurrentDifficulty": 0, //CANT UPDATE THE DIFICULTY, IT CRASHES THE GAME
                "HighestDifficultyCompleted": 3
              }
            },
            "RuntimeNodeData": gather_rift_data(settings.RiftConfigSlug), //Here goes all the rift's data we gather before
          },
          "RiftState": {},
          "bNeverJoinable": false,
          "MatchID": MatchID,
        },
        "Cluster": "ec2-us-east-1-dokken"
      },
      "metadata": null,
      "return_code": 0
    });
  } catch(error){
    console.log(`Error?: ${error}`);
  }
}

//Gather's Host_Player gems choice
export async function handleSsc_invoke_lock_rift_lobby_loadout(req: Request, res: Response) {
  const account = req.token;
  const settings:any = req.body;

  let character = settings.Loadout.Character;
  let variant = settings.Loadout.Skin;
  const loadout = { Character: character, Skin: variant };
  
  await redisUpdatePlayerRiftsData(account.id, {
    riftHostCharacter: loadout.Character,
    riftHostSkin: loadout.Skin
  } as RedisRifts);
  
  res.send({
    "body": {
        "AccountId": account.id,
        "Loadout": {
            "Character": loadout.Character,
            "Skin": loadout.Skin
        },
        "Gems": [
            {
                "Gem": "gem_horror_circle_on_dodge_smoke_bomb",
                "ChargeLevel": 20
            },
            {
                "Gem": "gem_horror_circle_chance_on_hit_ice",
                "ChargeLevel": 20
            },
            {
                "Gem": "gem_horror_circle_share_elemental_debuffs",
                "ChargeLevel": 20
            }
        ],
        "bAreAllLoadoutsLocked": true
    },
    "metadata": null,
    "return_code": 0
  });
}

async function createRiftMatch(playersData:any){
  const matchId = ObjectID().toHexString();
  const resultId = ObjectID().toHexString();



  // Create match object
  const match: any = {
    matchId,
    resultId,
    status: "queued",
    createdAt: Date.now(),
    matchKey: randomBytes(32).toString("base64"),
  };

  // Store match data
  await redisUpdateMatch(match.matchId, match);

  //console.log("PLAYER:",playersData);

  const player_1 = {
    playerId: playersData.id,
    partyId: playersData.partyId,
    playerIndex: 0,
    teamIndex: 0,
    isHost: true,
    ip: (await redisGetPlayer(playersData.id)).ip
  }

  const notification: any = {
    players: [player_1],
    matchId: match.matchId,
    matchKey: match.matchKey,
    map: playersData.map,
    mode: "rifts"
  };

  await redisUpdatePlayerRiftsData(playersData.id, {
    riftKey: match.matchKey,
  } as RedisRifts);

  // Notify about the match creation
  await redisOnGameplayConfigNotified(notification);

  // match ready
  await redisGameServerInstanceReady(matchId, [playersData.id]);

  return match;
}

interface PlayerConfig {
  AccountId: string,
  Taunts: string[],
  BotBehaviorOverride: string,
  bAutoPartyPreference: boolean,
  Gems: string[],
  PartyMember: null,
  GameplayPreferences: number,
  BotDifficultyMax: number,
  bIsBot: boolean,
  RankedDivision: null,
  bUseCharacterDisplayName: boolean,
  StartingDamage: number,
  TeamIndex: number,
  ProfileIcon: string,        
  WinStreak: null,
  RankedTier: null,
  Handicap: number,
  RingoutVfx: string,
  Character: string,
  Banner: string,
  StatTrackers: string[],
  Perks: string[],
  PlayerIndex: number,
  PartyId: string,
  Username: {},
  Buffs: string[],
  Skin: string,
  BotDifficultyMin: number
}

const default_player:PlayerConfig = {
  AccountId: '',
  Taunts: [ '', '', '', '' ],   
  BotBehaviorOverride: '',
  bAutoPartyPreference: true,
  Gems: [],
  PartyMember: null,
  GameplayPreferences: 544,
  BotDifficultyMax: 0,
  bIsBot: false,
  RankedDivision: null,
  bUseCharacterDisplayName: false,
  StartingDamage: 0,
  TeamIndex: 0,
  ProfileIcon: '',        
  WinStreak: null,
  RankedTier: null,
  Handicap: 0,
  RingoutVfx: '',
  Character: "",
  Banner: '',
  StatTrackers: [ '', '', '' ],
  Perks: [],
  PlayerIndex: 0,
  PartyId: '',
  Username: {},
  Buffs: [],
  Skin: "",
  BotDifficultyMin: 0
}

interface node_info {
    NodeMap: string;
    NodeAttunement: string;
    NodeCountdownDisplay: string;
    NodebAllowMapHazards: boolean;
    NodeMode: string;
  }

export async function handleSsc_invoke_start_rift_node(req: Request, res: Response) {
  const account = req.token;
  const settings: any = req.body;
  const playerRiftsData = await redisGetPlayerRiftsData(account.id) as RedisRifts;

  let loadout = {
    Character: "character_shaggy",
    Skin: "skin_shaggy_default"
  }

  if (playerRiftsData){
    loadout.Character = ""+playerRiftsData.riftHostCharacter as string;
    loadout.Skin = ""+playerRiftsData.riftHostSkin as string;
  }

  let NodeData:node_info = {
    NodeMap: "M001",
    NodeAttunement: "",
    NodeCountdownDisplay: "",
    NodebAllowMapHazards: false,
    NodeMode: "1v1"
  }
  let TeamsInfo:any = {};

  let player_config:PlayerConfig = structuredClone(default_player);
  player_config.AccountId = account.id;
  player_config.Character = loadout.Character;
  player_config.Skin = loadout.Skin;
  player_config.RingoutVfx = "ring_out_vfx_default";
  player_config.Banner = "banner_wbtower_epic";
  const profile = await PlayerTesterModel.findById(account.id);
  if (profile){
    player_config.GameplayPreferences = profile.gameplay_preferences;
    player_config.ProfileIcon = profile.profile_icon;
  }

  TeamsInfo[account.id] = player_config;

  const chapters = gather_rift_data(playerRiftsData.riftChapter) as any; //here we get all the data by it's rift code name
  //we do this for each chapter in the rift node
  for (const chapter in chapters){
    if (chapter == settings.NodeId){
      const team_data:any = chapters[chapter];
      NodeData.NodeMap = team_data.Map;
      NodeData.NodeAttunement = team_data.Attunement;
      NodeData.NodeCountdownDisplay = team_data.CountdownDisplay;
      NodeData.NodebAllowMapHazards = team_data.bAllowMapHazards;

      const count = (team_data.EnemyTeams[0].BotLoadouts as String[]).length;
      console.log("node found, enemies:",count);
      if (count == 2){ NodeData.NodeMode = "2v2"; }
      for(let i=0;i<count;i++){
        let bot:PlayerConfig = structuredClone(default_player);
        bot.bIsBot = true;
        bot.TeamIndex = 1;
        bot.PlayerIndex = 1+i+i;
        bot.bUseCharacterDisplayName = true;
        bot.AccountId = team_data.EnemyTeams[0].BotLoadouts[i].AccountId;
        bot.Character = team_data.EnemyTeams[0].BotLoadouts[i].Character;
        bot.Skin = team_data.EnemyTeams[0].BotLoadouts[i].Skin;
        bot.Banner = team_data.EnemyTeams[0].BotLoadouts[i].Banner;
        bot.ProfileIcon = team_data.EnemyTeams[0].BotLoadouts[i].ProfileIcon;
        bot.RingoutVfx = team_data.EnemyTeams[0].BotLoadouts[i].RingOutVfx;
        TeamsInfo[bot.AccountId] = bot;
      }
      break;
    }
  }
  
  const playerData = {
    id: account.id,
    partyid: settings.RiftLobbyId,
    map: NodeData.NodeMap,
  }

  const match = await createRiftMatch(playerData);

  const message:any = {
    data: {
      MatchId: match.matchId,
      GameplayConfig: {
        ArenaModeInfo: null,
        RiftNodeId: settings.NodeId,
        ScoreEvaluationRule: 'TargetScoreIsWin',     
        bIsPvP: false,
        ScoreAttributionRule: 'AttributeToAttacker', 
        MatchDurationSeconds: 120,
        Created: {
          _hydra_unix_date: MVSTime(new Date()),
        },
        EventQueueSlug: '',
        bModeGrantsProgress: true,
        TeamData: [],
        Spectators: {},
        bIsRanked: false,
        bIsCustomGame: false,
        Players: TeamsInfo,
        CustomGameSettings: {
          bHazardsEnabled: false,
          bShieldsEnabled: false,
          MatchTime: 60,
          NumRingouts: 2,
        },
        HudSettings: {
          bDisplayPortraits: true,
          bDisplayStocks: true,
          bDisplayTimer: true,
        },
        bIsCasualSpecial: false,
        bAllowMapHazards: NodeData.NodebAllowMapHazards,
        RiftNodeAttunement: NodeData.NodeAttunement,      
        CountdownDisplay: NodeData.NodeCountdownDisplay,      
        Cluster: 'ec2-us-east-1-dokken',
        WorldBuffs: [],
        bIsTutorial: false,
        MatchId: match.matchId,
        bIsOnlineMatch: true,
        ModeString: NodeData.NodeMode,
        Map: NodeData.NodeMap,
        bIsRift: true
      },
      template_id: 'OnGameplayConfigNotified'        
    },
    payload: {
      match: { id: match.matchId },     
      custom_notification: 'realtime'
    },
    header: '',
    cmd: 'update'
  }; 
  
  //not sure how to make this part - so is in between comment bars for now
  /*await redisUpdatePlayerRiftsData(account.id, {
    riftMessage: structuredClone(message.data.GameplayConfig),
  } as RedisRifts);*/

  const notification: any = {
    message: message,
    accountID: account.id,
  };
  await redisClient.publish(ON_FORCE_MATCH, JSON.stringify(notification));
  
  res.send({ "body": {}, "metadata": null, "return_code": 0 });
}

//security stuff for the rifts
export async function handleSsc_invoke_load_gameplay_config(req: Request, res: Response){
  const account = req.token;
  const playerRiftsData = await redisGetPlayerRiftsData(account.id) as RedisRifts;

  let GameplayConfig:any = {};
  let MatchKey = "";

  if (playerRiftsData){
    MatchKey = ""+playerRiftsData.riftKey as string;
    //GameplayConfig = structuredClone(playerRiftsData.riftMessage) as any;
    //console.log("GameplayConfig:",GameplayConfig);
  }

  res.send({ "body": {
    "GameplayConfig": GameplayConfig,
    "Key": MatchKey,
  }, "metadata": null, "return_code": 0 });
}

//Leave lobby
export async function handleSsc_invoke_leave_player_lobby(req: Request, res: Response){
  const account = req.token;
  const settings:any = req.body;
  
  let character = "";
  let variant = "";
  let profileIcon = "";

  const playerData = await PlayerTesterModel.findOne({ _id: new Types.ObjectId(account.id) });
  //let profileicon = ""
  if (playerData) {
    character = playerData.character;
    variant = playerData?.variant;
  }

  const loadout = { Character: character, Skin: variant };

  let ip = req.ip!.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1") {
    ip = env.LOCAL_PUBLIC_IP;
  }
  const lobbyMode = LOBBY_MODES.ONE_V_ONE; // Default mode, can be changed later;
  const newLobby = await createLobby(account.id, lobbyMode);
  
  res.send({
    "body": {
        "lobby": {
            "Teams": [
                {
                    "TeamIndex": 0,
                    "Players": {
                        [account.id]: {
                          "Account": { "id": [account.id] },
                          "JoinedAt": MVSTime(new Date()),
                          "BotSettingSlug": "",
                          "LobbyPlayerIndex": 0,
                          "CrossplayPreference": 1
                        }
                    },
                    "Length": 1
                },
                { "TeamIndex": 1, "Players": {}, "Length": 0 },
                { "TeamIndex": 2, "Players": {}, "Length": 0 },
                { "TeamIndex": 3, "Players": {}, "Length": 0 },
                { "TeamIndex": 4, "Players": {}, "Length": 0 }
            ],
            "LeaderID": account.id,
            "LobbyType": 0,
            "ReadyPlayers": {},
            "PlayerGameplayPreferences": {
                [account.id]: settings.GameplayPreferences
            },
            "PlayerAutoPartyPreferences": {
                [account.id]: settings.AutoPartyPreference
            },
            "GameVersion": env.GAME_VERSION,
            "HissCrc": settings.HissCrc,
            "Platforms": { [account.id]: settings.Platform },
            "AllMultiplayParams": {
              "1": {
              "MultiplayClusterSlug": "ec2-us-east-1-dokken",
              "MultiplayProfileId": "1252499",
              "MultiplayRegionId": ""
              },
              "2": {
                  "MultiplayClusterSlug": "ec2-us-east-1-dokken",
                  "MultiplayProfileId": "1252922",
                  "MultiplayRegionId": "19c465a7-f21f-11ea-a5e3-0954f48c5682"
              },
              "3": {
                  "MultiplayClusterSlug": "",
                  "MultiplayProfileId": "1252925",
                  "MultiplayRegionId": ""
              },
              "4": {
                  "MultiplayClusterSlug": "ec2-us-east-1-dokken",
                  "MultiplayProfileId": "1252928",
                  "MultiplayRegionId": "19c465a7-f21f-11ea-a5e3-0954f48c5682"
              }
            },
            "LockedLoadouts": {
                [account.id]: {
                    "Character": loadout.Character,
                    "Skin": loadout.Skin
                }
            },
            "ModeString": "1v1",
            "IsLobbyJoinable": true,
            "MatchID": newLobby.id
        }
    },
    "metadata": null,
    "return_code": 0
  });
}


export async function handleSsc_invoke_perks_get_all_pages(req: Request<{}, {}, {}, {}>, res: Response) {
  const accountId = req.token.id;

  PerkPagesModel.findOne({ account_id: new Types.ObjectId(accountId) })
    .select("perk_pages -_id")
    .lean()
    .exec()
    .then((doc) => {
      res.send({
        body: {
          perk_pages: doc?.perk_pages || {},
        },
        metadata: null,
        return_code: 0,
      });
    })
    .catch((e) => {
      console.log(e);
      res.send({
        body: {
          perk_pages: {},
        },
        metadata: null,
        return_code: 0,
      });
    });
}

export interface SET_LOBBY_MODE_REQ {
  AutoPartyPreference: boolean;
  CrossplayPreference: number;
  GameplayPreferences: number;
  HissCrc: number;
  LobbyId: string;
  LobbyTemplate: string;
  ModeString: string;
  Platform: string;
  Version: string;
}

export async function handle_ssc_set_lobby_mode(req: Request<{}, {}, SET_LOBBY_MODE_REQ, {}>, res: Response) {
  const account = req.token;
  await changeLobbyMode(account.id, req.body.LobbyId, req.body.ModeString as LOBBY_MODES);
  res.send({
    body: {},
    metadata: null,
    return_code: 0,
  });
}

