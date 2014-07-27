var fs = require('fs');
var PF = require('pathfinding');
var ProceduralTerrain = require(__dirname + '/proceduralterrain.js');
var randomnamegen = require(__dirname + '/randomnamegen.js');
var ejs = require('ejs');
var express = require('express');
var app = express();
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var http = require('http').Server(app);
var io = require('socket.io')(http);

var users = [];

var background_map = [];
var physical_map = [];
var pathfinding_map = [];
var walkable_items = [];
var interaction_map = [];

var user_map_height = 25;
var user_map_width = 37;

var advancement_age = 10000;

var race_char_codes = [100, 130, 160, 190];

var physical_object_types = [{
	name: 'Tree',
	tiles: [9, 11],
	strength: 15,
	drop_function: function(x, y){
		walkable_items[y][x] = 43;
		//drop seed to the left
		if (inBounds(x - 1, y) && !checkIfPhysical(x - 1, y) && !checkIfItem(x - 1, y) && Math.random() < 0.5){
			walkable_items[y][x - 1] = 44;
		}
	},
},{
	name: 'Berry bush',
	tiles: [40],
	strength: 5,
	drop_function: function(x, y){
		walkable_items[y][x] = 42;
	},
},{
	name: 'Wooden wall',
	tiles: [46],
	strength: 20,
	drop_function: function(x, y){
		walkable_items[y][x] = 43;
	},
}];

var walkable_object_types =[{
	name: 'Berries',
	tiles: [42],
	eat_function: function(usernum){
		users[usernum].hunger = Math.max(0, users[usernum].hunger - 20);
		users[usernum].holding = null;
	},
	place_function: function(x, y, usernum){
		if (isEmptySpace(x, y)){
			physical_map[y][x] = 41;
			users[usernum].holding = null;
		}
	}
},{
	name: 'Log',
	tiles: [43],
	eat_function: function(usernum){
		tellUser(usernum, 'Game: You try to eat the log but fail. Drop it with q or build a wall with it using shift+w/a/s/d');
	},
	place_function: function(x, y, usernum){
		if (isEmptySpace(x, y)){
			physical_map[y][x] = 46;
			users[usernum].holding = null;
		}
	}
}];

function isEmptySpace(x, y){
	if (inBounds(x, y) && !checkIfPhysical(x, y) && !checkIfItem(x, y)){
		return true;
	}
	return false;
}

var game_html = fs.readFileSync(__dirname + '/views/game.html', 'utf8');
var logged_out_html = fs.readFileSync(__dirname + '/views/logged_out.html', 'utf8');

setInterval(function(){
	game_html = fs.readFileSync(__dirname + '/views/game.html', 'utf8');
	logged_out_html = fs.readFileSync(__dirname + '/views/logged_out.html', 'utf8');
},3000);


generateMap();

app.use(cookieParser('this is a signature'));
app.use(bodyParser.json());
app.disable('x-powered-by');
app.use('/static', express.static(__dirname + '/static'));

app.get('/', cookieAuth, function(req, res){
	res.send(ejs.render(game_html, {'uuid': users[req.usernum].uuid}));
});

app.get('/random-name', function(req, res){
	if (!req.query.race || ['dwarf', 'human', 'elf', 'goblin'].indexOf(req.query.race) == -1) req.query.race = 'dwarf';
	res.send(randomnamegen(req.query.race, true));
});

app.get('/create-character', function(req, res){
	console.log('creating character');
	createUser(req.query.name, req.query.race, (req.header('X-Real-IP') || req.header('x-forwarded-for') || req.connection.remoteAddress), function(err, user){
		if (err) return res.send(ejs.render(logged_out_html, {'message': err}));
		res.cookie('adventuremode', { uuid: user.uuid }, { expires: new Date(new Date().getTime()+99396409000) });
		setTimeout(function(){
			console.log('redirecting');
			res.redirect('/');
		}, 300);
		return;
	});
});



io.on('connection', function(socket){
	socket.on('disconnect', function(){
		if (socket.usernum) users[socket.usernum].socket = null;
		console.log('user disconnected');
	});
	socket.on('chat', function(msg){
		if (isNaN(socket.usernum)) return socket.emit('error_pop_up', 'You\'re not currently logged in');
		//check if user has a loudspeaker object (allowing them to talk to whole map)
		users[socket.usernum].chat = msg.replace(/[^a-zA-Z0-9 ,'@#%"/~;\.\\\+\*\?\[\^\]\$\(\)\{\}\=\!\|\:\-]/g, ''); 
		// localChat(socket.usernum, msg);
	});
	socket.on('move', function(charcode){
		if (isNaN(socket.usernum)) return socket.emit('error_pop_up', 'You\'re not currently logged in');
		charcode = parseInt(charcode);
		if (isNaN(charcode)) return socket.emit('error_pop_up', 'Not a valid input');
		users[socket.usernum].move = charcode;
	});
	socket.on('ping', function(){
		if (isNaN(socket.usernum)) return socket.emit('error_pop_up', 'You\'re not currently logged in');
		users[socket.usernum].last_heard_from = new Date().getTime();
		socket.emit('ping');
	});
	socket.on('login', function(uuid){
		console.log('user logged in')
		findUser(uuid, function(err, usernum, user){
			if (err) return socket.emit('error_pop_up', 'Something went wrong');
			if (user.health <= 0) return socket.emit('error_pop_up', 'Your character died. Please refresh the page');
			socket.usernum = usernum;
			socket.uuid = user.uuid;
			console.log('socket.usernum = ' + socket.usernum);
			users[usernum].socket = socket;
			users[usernum].last_heard_from = new Date().getTime();
			socket.emit('login', user.name);
			//send map here too? maybe as a single socket call, like update, {user, map}
		});
	});
});

http.listen(80, function(){
	console.log('server started');
});


function moveUser(usernum){
	var new_prospective_position = [users[usernum].x, users[usernum].y]; //[x, y]
	if (users[usernum].move == 100) new_prospective_position[0]++; //d
	if (users[usernum].move == 97) new_prospective_position[0]--; //a
	if (users[usernum].move == 115) new_prospective_position[1]++; //s
	if (users[usernum].move == 119) new_prospective_position[1]--; //w
	//check if in bounds and not blocked by anything
	if (inBounds(new_prospective_position[0], new_prospective_position[1]) && !checkIfPhysical(new_prospective_position[0], new_prospective_position[1])){
		switchTiles(users[usernum].x, users[usernum].y, new_prospective_position[0], new_prospective_position[1]);
		users[usernum].x = new_prospective_position[0];
		users[usernum].y = new_prospective_position[1];
	}
	return;
}

function interactUser(usernum){
	var interaction_position = [users[usernum].x, users[usernum].y]; //[x, y]
	if (users[usernum].move == 68) interaction_position[0]++; //D
	if (users[usernum].move == 65) interaction_position[0]--; //A
	if (users[usernum].move == 83) interaction_position[1]++; //S
	if (users[usernum].move == 87) interaction_position[1]--; //W
	//check if in bounds and not blocked by anything
	if (inBounds(interaction_position[0], interaction_position[1])){
		setCharacterInteracting(usernum);
		//something is there already:
		if (checkIfPhysical(interaction_position[0], interaction_position[1])){
			//check if person
			if (checkIfUser(interaction_position[0], interaction_position[1])){
				users[usernum].block_interacting = null;
				var attacked_user = findUserByLocation(interaction_position[0], interaction_position[1]);
				if (!users[attacked_user].health){
					tellUser(usernum, 'Game: This is the corpse of ' + users[attacked_user].name);
					// users[usernum].socket.emit('server_msg', 'Game: This is the corpse of ' + users[attacked_user].name);
				} else {
					users[attacked_user].health -= users[usernum].strength;
					
					if (!users[attacked_user].health){
						// users[attacked_user].socket.emit('error_pop_up', 'You were slain by ' + users[usernum].name);
						alertUser(attacked_user, 'Game: You were slain by ' + users[usernum].name)
						setCharacterDead(attacked_user);
						users[usernum].strength++;
						tellUser(usernum, 'Game: You have slain ' + users[attacked_user].name);
						// users[usernum].socket.emit('server_msg', 'You have slain ' + users[attacked_user].name);
					} else {
						users[attacked_user].being_attacked = true;
						setCharacterAttacked(attacked_user);
					}
				}
			//check what the block interaction is of physical item:
			} else if (users[usernum].block_interacting && users[usernum].block_interacting[0] == interaction_position[0] && users[usernum].block_interacting[1] == interaction_position[1]){
				users[usernum].block_interacting_progress += users[usernum].strength;
				
				var max_block_strength = physical_object_types[findPhysicalObject(physical_map[users[usernum].block_interacting[1]][users[usernum].block_interacting[0]])].strength;
				
				//set interaction map progress
				interaction_map[interaction_position[1]][interaction_position[0]] = 10 + Math.floor((users[usernum].block_interacting_progress / max_block_strength) * 10);
				
				// setUserInteractionProgress(usernum, physical_object_types[findPhysicalObject(physical_map[users[usernum].block_interacting[1]][users[usernum].block_interacting[0]])].strength);
				
				// console.log('tile: ' + physical_map[users[usernum].block_interacting[1]][users[usernum].block_interacting[0]]);
				// console.log('physical object: ' + findPhysicalObject(physical_map[users[usernum].block_interacting[1]][users[usernum].block_interacting[0]]));
				// console.log('strength: ' + physical_object_types[findPhysicalObject(physical_map[users[usernum].block_interacting[1]][users[usernum].block_interacting[0]])].strength);
				if (users[usernum].block_interacting_progress > max_block_strength){
					convertPhysicalToItem(users[usernum].block_interacting[0], users[usernum].block_interacting[1]);
					users[usernum].block_interacting = null;
					users[usernum].block_interacting_progress = 0;
				}
			//new block that is being interacted with
			} else {
				users[usernum].block_interacting = [interaction_position[0], interaction_position[1]];
				users[usernum].block_interacting_progress = 0;
				users[usernum].block_interacting_progress += users[usernum].strength;
			}
		//nothing is there
		} else if (users[usernum].holding){
			placeItem(interaction_position[0], interaction_position[1], usernum);
		}
	}
	return;
}

function placeItem(x, y, usernum){
	var temp_item_num = findWalkableObject(users[usernum].holding)
	if (temp_item_num == -1) return tellUser(usernum, 'Game: This item can\'t be constructed or planted');
	walkable_object_types[temp_item_num].place_function(x, y, usernum);
	return;
}

function pickUpItem(usernum){
	if (users[usernum].holding) return tellUser(usernum, 'Game: You\'re already holding an item. Construct/plant it with shift+w/a/s/d or drop it with q before picking something else up.');
	if (walkable_items[users[usernum].y][users[usernum].x]){
		users[usernum].holding = walkable_items[users[usernum].y][users[usernum].x];
		walkable_items[users[usernum].y][users[usernum].x] = null;
	}
	return;
}

// game loop
setInterval(function(){
	//clear out the interaction map:
	nullifyArray(interaction_map);
	//inputs
	for (var i = 0; i < users.length; i++) {
		if (!users[i].health){
			setCharacterDead(i);
		} else {
			if (!users[i].being_attacked) resetCharacterTile(i);
			
			if (users[i].chat){
				localChat(i, users[i].chat);
				setCharacterTalking(i);
				users[i].chat = null;
			}
			
			if (users[i].move){
				//WASD
				if ([119, 115, 97, 100].indexOf(users[i].move) != -1){
					moveUser(i);
				}
				//shift + WASD
				if ([87, 83, 65, 68].indexOf(users[i].move) != -1){
					interactUser(i);
				}
				// e
				if (users[i].move == 101){
					pickUpItem(i);
				}
				//todo handle other actions here
				users[i].move = null;
				
			}
		}
	}
	
	//go through each user?
	//go through each building
	//go through each mob
	//go through each user again and generate user info and map
	for (var i = 0; i < users.length; i++) {
		//set the being attacked interaction here because otherwise it could get moved:
		if (users[i].being_attacked) setCharacterAttacked(i);
		// if (users[i].being_attacked) interaction_map[users[usernum].y][users[usernum].x] = 4;
		
		if (users[i].socket && (new Date().getTime()) - users[i].last_heard_from < 20000){
			//increment their play time counter:
			users[i].play_time++;
			//generate map segment:
			var user_map_segment = [];
			var user_interaction_map_segment = [];
			for (var y = 0; y < user_map_height; y++) {
				user_map_segment.push([]);
				user_interaction_map_segment.push([]);
				for (var x = 0; x < user_map_width; x++) {
					user_map_segment[y].push(null);
					user_interaction_map_segment[y].push(null);
					
					var translated_y = users[i].y - Math.floor(user_map_height / 2) + y;
					var translated_x = users[i].x - Math.floor(user_map_width / 2) + x;
					//is a valid map position:
					if (translated_y > -1 && translated_y < background_map.length && translated_x > -1 && translated_x < background_map[0].length){
						user_map_segment[y][x] = background_map[translated_y][translated_x];
						if (walkable_items[translated_y][translated_x]) user_map_segment[y][x] = walkable_items[translated_y][translated_x];
						if (physical_map[translated_y][translated_x] > 1) user_map_segment[y][x] = physical_map[translated_y][translated_x];
						if (interaction_map[translated_y][translated_x]) user_interaction_map_segment[y][x] = interaction_map[translated_y][translated_x];
					}
				}
			}
			users[i].socket.emit('update', {
				'map': user_map_segment,
				'interaction': user_interaction_map_segment,
				'user': {
					x: users[i].x,
					y: users[i].y,
					health: users[i].health,
					hunger: users[i].hunger,
					thirst: users[i].thirst,
					strength: users[i].strength,
					agility: users[i].agility,
					holding: users[i].holding,
					being_attacked: users[i].being_attacked,
					standing_on: walkable_items[users[i].y][users[i].x],
				}
			});
			// for (var y = Math.max(0, users[i].y - user_map_offset_y); y < Math.min(background_map.length, users[i].y + user_map_offset_y); y++) {
			// 	for (var x = Math.max(0, users[i].x - user_map_offset_x); x < Math.min(background_map[y].length, users[i].x + user_map_offset_x); x++) {
					
			// 	}
			// }
			// users[i].socket.emit('local_chat', 'testing game loop');
		}
	}

},400);



function tellUser(usernum, message){
	if (users[usernum].socket) users[usernum].socket.emit('server_msg', message);
	return;
}
function alertUser(usernum, message){
	if (users[usernum].socket) users[usernum].socket.emit('error_pop_up', message);
	return;
}

function resetCharacterTile(usernum){
	physical_map[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + (users[usernum].play_time > advancement_age ? 1 : 0);
	return;
}

function setCharacterTalking(usernum){
	// physical_map[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + 2 + (users[usernum].play_time > advancement_age ? 1 : 0);
	interaction_map[users[usernum].y][users[usernum].x] = 1; //talking (blue?)
	return;
}

function setCharacterShouting(usernum){
	// physical_map[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + 4 + (users[usernum].play_time > advancement_age ? 1 : 0);
	interaction_map[users[usernum].y][users[usernum].x] = 2;
	return;
}

function setCharacterInteracting(usernum){
	// physical_map[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + 6 + (users[usernum].play_time > advancement_age ? 1 : 0);
	interaction_map[users[usernum].y][users[usernum].x] = 3;
	return;
}

// function setUserInteractionProgress(usernum, max_block_strength){
// 	interaction_map[users[usernum].y][users[usernum].x] = 10 + Math.floor((users[usernum].block_interacting_progress / max_block_strength) * 10);
// 	return;
// }

function setCharacterAttacked(usernum){
	// physical_map[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + 8 + (users[usernum].play_time > advancement_age ? 1 : 0);
	interaction_map[users[usernum].y][users[usernum].x] = 10 + Math.floor((users[usernum].health / 100) * 10);
	//can't put interaction map change here because it could move?
	return;
}

function setCharacterDead(usernum){
	walkable_items[users[usernum].y][users[usernum].x] = race_char_codes[users[usernum].race] + 10 + (users[usernum].play_time > advancement_age ? 1 : 0);
	pathfinding_map.setWalkableAt(users[usernum].x, users[usernum].y, true);
	physical_map[users[usernum].y][users[usernum].x] = null;
	return;
}

function switchTiles(oldx, oldy, newx, newy){
	physical_map[newy][newx] = physical_map[oldy][oldx];
	physical_map[oldy][oldx] = 0;
	pathfinding_map.setWalkableAt(newx, newy, false);
	pathfinding_map.setWalkableAt(oldx, oldy, true);
};

function convertPhysicalToItem(x, y){
	pathfinding_map.setWalkableAt(x, y, true);
	physical_object_types[findPhysicalObject(physical_map[y][x])].drop_function(x, y);
	physical_map[y][x] = null;
}

function findPhysicalObject(tile){
	for (var i = 0; i < physical_object_types.length; i++) {
		if (physical_object_types[i].tiles.indexOf(tile) != -1){
			return i;
		}
	}
	return -1;
}

function findWalkableObject(tile){
	for (var i = 0; i < walkable_object_types.length; i++) {
		if (walkable_object_types[i].tiles.indexOf(tile) != -1){
			return i;
		}
	}
	return -1;
}

function inBounds(x, y){
	if (x > -1 && x < background_map[0].length && y > -1 && y < background_map.length){
		return true;
	}
	return false;
}

function checkIfPhysical(x, y){
	if (physical_map[y][x]) return true;
	return false;
}

function checkIfItem(x, y){
	if (walkable_items[y][x]) return true;
	return false;
}

function checkIfUser(x, y){
	if (physical_map[y][x] >= 100 && physical_map[y][x] <= 220) return true;
	return false;
}

function findUserByLocation(x, y){
	for (var i = 0; i < users.length; i++) {
		if (users[i].x == x && users[i].y == y) return i;
	}
}

function localChat(usernum, msg){
	var min_x = users[usernum].x - Math.floor(user_map_width / 2);
	var min_y = users[usernum].y - Math.floor(user_map_height / 2);
	var max_x = users[usernum].x + Math.floor(user_map_width / 2);
	var max_y = users[usernum].y + Math.floor(user_map_height / 2);
	
	for (var i = 0; i < users.length; i++) {
		if (users[i].socket && (new Date().getTime()) - users[i].last_heard_from < 20000){
			if (users[i].x >= min_x && users[i].x <= max_x && users[i].y >= min_y && users[i].y <= max_y){
				users[i].socket.emit('local_chat', users[usernum].name + ': ' + msg);
			}
		}
	}
}

function findUninhabitedTile(nearx, neary){
	var temp_distance = 10;
	var x = nearx;
	var y = neary;
	var found = false;
	while (temp_distance < 500 && !found){
		while (!found){
			x = nearx + (Math.floor(Math.random() * temp_distance) * (Math.random() > 0.5 ? -1 : 1));
			y = neary + (Math.floor(Math.random() * temp_distance) * (Math.random() > 0.5 ? -1 : 1));
			if (inBounds(x, y) && !physical_map[y][x]){
				found = true;
			}
			if (Math.random() > 0.7) temp_distance++;
		}
	}
	return [x, y];
}

function generateRandomIntInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createEmptyArray(width, height){
	var new_array = [];
	for (var y = 0; y < height; y++) {
		new_array.push([]);
		for (var x = 0; x < width; x++) {
			new_array[y].push(null);
		}
	}
	return new_array;
}

function nullifyArray(arr){
	for (var y = 0; y < arr.length; y++) {
		for (var x = 0; x < arr[y].length; x++) {
			arr[y][x] = null;
		}
	}
	return;
}

function generateMap(){
	var width = 1000;
	var height = 1000;
	var details = 50;
	var granularity = 0.3;
	var water_level = details * 0.2;
	var map = new ProceduralTerrain({height:height,width:width,details:details,granularity:granularity,water_level:water_level});
	background_map = map.getBackgroundMap();
	physical_map = map.getPhysicalMap();
	pathfinding_map = new PF.Grid(width, height, physical_map);
	walkable_items = [];
	interaction_map = [];
	for (var y = 0; y < physical_map.length; y++) {
		walkable_items.push([]);
		interaction_map.push([]);
		for (var x = 0; x < physical_map[y].length; x++) {
			walkable_items[y].push(null);
			interaction_map[y].push(null);
			// if (physical_map[y][x]) pathfinding_map.setWalkableAt(x, y, false);
		}
	}
	console.log('map created');
}

function findUser(uuid, callback){
	for (var i = 0; i < users.length; i++) {
		if (users[i].uuid == uuid) return callback(null, i, users[i]);
	}
	return callback('user not found', null, null);
}

function cookieAuth(req, res, next){
	if (req.cookies && req.cookies.adventuremode){
		findUser(req.cookies.adventuremode.uuid, function(err, usernum, user){
			if (err) return res.send(ejs.render(logged_out_html, {'message': 'Your character wasn\'t found likely because it was from the previous round. Create a new one?'}));
			if (user.health <= 0) return res.send(ejs.render(logged_out_html, {'message': 'Your character is dead. Create a new one?'}));
			req.usernum = usernum;
			next();
		});
	} else {
		return res.send(ejs.render(logged_out_html, {'message': ''}));
	}
}

function createUser(name, race, ip, callback){
	//todo: check name and race for validity
	if (['dwarf', 'elf', 'human', 'goblin'].indexOf(race) == -1) return callback('invalid race', null);
	name = name.replace(/[^A-Za-z0-9 ,'-]/g, '');
	if (name.length > 50) return callback('Sorry, that name is too long. Pick something under 50 characters', null);
	if (!name || ['admin', 'server', 'ben', 'ben wasser', 'benjamin wasser'].indexOf(name.toLowerCase()) != -1) return callback('Sorry, that name is already taken', null);
	for (var i = 0; i < users.length; i++) {
		if (users[i].name.toLowerCase() == name.toLowerCase()) return callback('Sorry, that name is already taken', null);
	}

	//todo: set starting location
	var start_pos = findUninhabitedTile(150, 150);
	physical_map[start_pos[1]][start_pos[0]] = race_char_codes[['dwarf', 'elf', 'human', 'goblin'].indexOf(race)];
	
	var user = {
		x: start_pos[0],
		y: start_pos[1],
		move: null,
		chat: null,
		socket: null,
		ip: ip,
		name: name,
		uuid: Math.random().toString(36).substr(2,8) + '' + Math.random().toString(36).substr(2,8) + '-' + (new Date().getTime()),
		health: 100,
		race: ['dwarf', 'elf', 'human', 'goblin'].indexOf(race),
		hunger: 0,
		thirst: 0,
		strength: 1, //(combat power: from fighting, chopping trees, carrying resources, placing resources?)
		agility: 1, //(chance for someone to miss: from distance traveled?)
		holding: null,
		block_interacting: null, //(which block user is trying to break)
		block_interacting_progress: 0, //(with each hit it goes up by strength)
		being_attacked: false,
		last_heard_from: new Date().getTime(), //used to check if socket has timed out
		play_time: 0,
	};
	users.push(user);
	callback(null, user);
}