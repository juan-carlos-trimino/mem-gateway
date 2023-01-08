/***
Gateway/Reverse Proxy
The gateway is the entry point to the app; it provides a REST API so the front end can interact
with the backend.
***/
const express = require('express');
const path = require('path');
const http = require('http');
const winston = require('winston');
const { randomUUID } = require('crypto');
const { lookup } = require('geoip-lite');

/******
Globals
******/
//Create a new express instance.
const app = express();
//When running an Express app behind a proxy, set the application variable 'trust proxy' to 'true.'
// app.set('trust proxy', true);
const SVC_NAME = process.env.SVC_NAME;
const APP_NAME_VER = process.env.APP_NAME_VER;
const SVC_DNS_METADATA = process.env.SVC_DNS_METADATA;
const SVC_DNS_HISTORY = process.env.SVC_DNS_HISTORY;
const SVC_DNS_VIDEO_UPLOAD = process.env.SVC_DNS_VIDEO_UPLOAD;
const SVC_DNS_VIDEO_STREAMING = process.env.SVC_DNS_VIDEO_STREAMING;
const SVC_DNS_KIBANA = process.env.SVC_DNS_KIBANA;
const PORT = process.env.PORT && parseInt(process.env.PORT) || 3000;
const MAX_RETRIES = process.env.MAX_RETRIES && parseInt(process.env.MAX_RETRIES) || 10;
let READINESS_PROBE = false;

/***
Resume Operation
----------------
The resume operation strategy intercepts unexpected errors and responds by allowing the process to
continue.
***/
process.on('uncaughtException',
err => {
  logger.error('Uncaught exception.', { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  logger.error(err.stack, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
})

/***
Abort and Restart
-----------------
***/
// process.on("uncaughtException",
// err => {
//   console.error("Uncaught exception:");
//   console.error(err && err.stack || err);
//   process.exit(1);
// })

//Winston requires at least one transport (location to save the log) to create a log.
const logConfiguration = {
  transports: [ new winston.transports.Console() ],
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSSSS' }),
    winston.format.json()
  ),
  exitOnError: false
}

//Create a logger and pass it the Winston configuration object.
const logger = winston.createLogger(logConfiguration);

/***
Unlike most other programming languages or runtime environments, Node.js doesn't have a built-in
special "main" function to designate the entry point of a program.

Accessing the main module
-------------------------
When a file is run directly from Node.js, require.main is set to its module. That means that it is
possible to determine whether a file has been run directly by testing require.main === module.
***/
if (require.main === module) {
  main()
  .then(() => {
    READINESS_PROBE = true;
    logger.info(`Microservice is listening on port ${PORT}!`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  })
  .catch(err => {
    logger.error('Microservice failed to start.', { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
    logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
    logger.error(err.stack, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  });
}

function main() {
  //Throw an exception if any required environment variables are missing.
  if (process.env.SVC_DNS_METADATA === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_METADATA.');
  }
  else if (process.env.SVC_DNS_HISTORY === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_HISTORY.');
  }
  else if (process.env.SVC_DNS_VIDEO_UPLOAD === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_VIDEO_UPLOAD.');
  }
  else if (process.env.SVC_DNS_VIDEO_STREAMING === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_VIDEO_STREAMING.');
  }
  else if (process.env.SVC_DNS_KIBANA === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_KIBANA.');
  }
  //Display a message if any optional environment variables are missing.
  else {
    if (process.env.PORT === undefined) {
      logger.info(`The environment variable PORT for the HTTP server is missing; using port ${PORT}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
    }
    //
    if (process.env.MAX_RETRIES === undefined) {
      logger.info(`The environment variable MAX_RETRIES is missing; using MAX_RETRIES=${MAX_RETRIES}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
    }
  }
  //Notify when server has started.
  return new Promise(resolve => {
    //Set directory that contains templates for views.
    app.set('views', path.join(__dirname, 'views'));
    //Use hbs as the view engine for Express.
    app.set('view engine', 'hbs');
    app.use(express.static("public"));
    app.listen(PORT,
    () => {
      resolve();  //HTTP server is listening, resolve the promise.
    });
  });
}

/***
The user IP is determined by the following order:
 1. X-Client-IP
 2. X-Forwarded-For (Header may return multiple IP addresses in the format: "client IP, proxy1 IP, proxy2 IP", so take the the first one.)
    It's very easy to spoof:
    $ curl --header "X-Forwarded-For: 1.2.3.4" "http://localhost:3000"
 3. CF-Connecting-IP (Cloudflare)
 4. Fastly-Client-Ip (Fastly CDN and Firebase hosting header when forwared to a cloud function)
 5. True-Client-Ip (Akamai and Cloudflare)
 6. X-Real-IP (Nginx proxy/FastCGI)
 7. X-Cluster-Client-IP (Rackspace LB, Riverbed Stingray)
 8. X-Forwarded, Forwarded-For and Forwarded (Variations of #2)
 9. req.connection.remoteAddress
10. req.socket.remoteAddress
11. req.connection.socket.remoteAddress
12. req.info.remoteAddress
If an IP address cannot be found, it will return null.
***/
function getIP(req) {
  let ip = null;
  try {
    ip = req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress || null;
    /***
    When the OS is listening with a hybrid IPv4-IPv6 socket, the socket converts an IPv4 address to
    IPv6 by embedding it within the IPv4-mapped IPv6 address format. This format just prefixes the
    IPv4 address with :ffff: (or ::ffff: for older mappings).
    Is the IP an IPv4 address mapped as an IPv6? If yes, extract the Ipv4.
    ***/
    const regex = /^:{1,2}(ffff)?:(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/i;  //Ignore case.
    if (ip !== null && regex.test(ip)) {
      ip = ip.replace(/^.*:/, '');
    }
  }
  catch (err) {
    ip = null;
    logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  }
  return ip;
}

//Readiness probe.
app.get('/readiness',
(req, res) => {
  const options = {
    host: SVC_DNS_METADATA,
    path: '/readiness',
    method: 'GET'
  };
  //Check upstream dependencies.
  http.request(options,
  (response) => {
    if (response.statusCode === 200) {
      READINESS_PROBE = true;
      res.sendStatus(200);
    }
    else {
      READINESS_PROBE = false;
      logger.info(`Upstream dependency ${SVC_DNS_METADATA} not ready.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
      res.sendStatus(500);
    }
  })
  .on('error',
  err => {
    READINESS_PROBE = false;
    logger.info(`Upstream dependency ${SVC_DNS_METADATA} not ready.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
    res.sendStatus(500);
  })
  .end();  //Finalize the request.
});

/***
Main web page for listing videos.

This route handler starts by requesting data from the metadata microservice. It then renders the
web page using the video-list template and input the list of videos as the template's data.
***/
app.get('/',
(req, res) => {
  const cid = randomUUID();
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: List the Videos.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  /***
  In the HTTP protocol, headers are case-insensitive; however, the Express framework converts
  everything to lower case. Unfortunately, for objects in JavaScript, their property names are
  case-sensitive.
  ***/
  const options = {
    host: SVC_DNS_METADATA,
    path: '/videos',
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  };
  //Get the list of videos from the metadata microservice.
  http.request(options,
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      /***
      An empty string is not a valid JSON string; JSON.parse(''); will not parse correctly.
      While an empty string is not valid JSON, two quotes is valid JSON; JSON.parse('""');
      will parse correctly.
      Valid minimal JSON strings are:
        The empty object '{}'
        The empty array '[]'
        The string that is empty '""'
        A number; e.g., '123.4'
        The boolean value true 'true'
        The boolean value false 'false'
        The null value 'null'
      ***/
      /***
      It renders a web page using the video-list template. It passes the array of videos in as the
      data for rendering the template.
      ***/
      if (response.statusCode === 500 || data === undefined || data === null || data === '') {
        res.render('video-list', { videos: JSON.parse('[]') });
      }
      else {
        res.render('video-list', { videos: JSON.parse(data).videos });
      }
    });
    response.on('error',
    err => {
      logger.error('Failed to retrieve the video collection.', { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      res.sendStatus(500);
    });
  })
  .on('error',
  err => {
    logger.error('Failed to retrieve the video collection.', { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
    logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
    res.sendStatus(500);
  })
  .end();
});

/***
Web page for playing a particular video.

The streaming video passes through three microservices on its journey to the user.
External Cloud Storage -> video-storage -> video-streaming -> gateway -> web browser -> user
***/
app.get('/video',
(req, res) => {
  const cid = randomUUID();
  const videoId = req.query.id;
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: Play Video ${videoId}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  //Get the selected video from the metadata microservice.
  http.request({
    host: SVC_DNS_METADATA,
    path: `/video?id=${videoId}`,
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      try {
        const metadata = JSON.parse(data).video;
        const video = { metadata, url: `/api/video?id=${videoId}` };
        logger.info(`Rendering the video ${metadata._id}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
        //Render the video for display in the browser.
        res.render('play-video', { video });
      }
      catch {
        logger.error(`Failed to get details for video ${videoId}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      }
    });
    response.on("error",
    err => {
      logger.error(`Failed to get details for video ${videoId}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      logger.error(err || `Status code: ${response.statusCode}`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      res.sendStatus(500);
    });
  })
  .end();
});

//Web page for uploading a new video.
app.get('/upload',
(req, res) => {
  res.render('upload-video', {});
});

//Web page for showing the users viewing history.
app.get('/history',
(req, res) => {
  const cid = randomUUID();
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: Viewing History.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  //Get the viewing history from the history microservice.
  http.request({
    host: SVC_DNS_HISTORY,
    path: '/videos',
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      //Render the history for display in the browser.
      if (response.statusCode === 500 || data === undefined || data === null || data === '') {
        res.render('history', { videos: JSON.parse('[]') });
      }
      else {
        res.render('history', { videos: JSON.parse(data).videos });
      }
    });
    response.on('error',
    err => {
      logger.error('Failed to retrieve the viewing history.', { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      logger.error(err, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      res.sendStatus(500);
    });
  })
  .end();
});

//HTTP GET API to stream video to the user's browser.
app.get('/api/video',
(req, res) => {
  const cid = randomUUID();
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: Streaming the Video ${req.query.id}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  //Forward the request to the video streaming microservice.
  const forwardReq = http.request({
    host: SVC_DNS_VIDEO_STREAMING,
    path: `/video?id=${req.query.id}`,
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  forwardRes => {
    res.writeHeader(forwardRes.statusCode, forwardRes.headers);
    /***
    It pipes the response (using Node.js streams) from the video-streaming microservice to the
    response for this request. This is where the video leaves the cluster.
    ***/
    forwardRes.pipe(res);
  });
  req.pipe(forwardReq);
});

//HTTP POST API to upload video from the user's browser.
app.post('/api/upload',
(req, res) => {
  const cid = randomUUID();
  /***
  In the HTTP protocol, headers are case-insensitive; however, the Express framework converts
  everything to lower case. Unfortunately, for objects in JavaScript, their property names are
  case-sensitive.
  ***/
  req.headers['x-correlation-id'] = cid;
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: Upload of the Video ${req.headers['file-name']}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  //Forward the request to the video streaming microservice.
  const forwardReq = http.request({
    host: SVC_DNS_VIDEO_UPLOAD,
    path: '/upload',
    method: 'POST',
    headers: req.headers
  },
  forwardRes => {
    res.writeHeader(forwardRes.statusCode, forwardRes.headers);
    /***
    It pipes the response (using Node.js streams) from the video-upload microservice to the
    response for this request.
    ***/
    forwardRes.pipe(res);
  });
  /***
  It pipes the request itself (the body of the request is the video) to another request.
  ***/
  req.pipe(forwardReq);
});

/***
Kibana.
***/
app.get('/kibana',
(req, res) => {
  const cid = randomUUID();
  const ip = getIP(req);
  logger.info(`Received request from ${ip}: Kibana.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
  // try {
  //   const geo = lookup(ip);
  //   logger.info(`${SVC_NAME} ${cid} - Request origination -> City: ${geo.city}, Region: ${geo.region}, Country: ${geo.country}, Timezone: ${geo.timezone}`);
  // }
  // catch {
  //   logger.info(`${SVC_NAME} ${cid} - Unrecognizable IP: ${ip}`);
  // }
  //Get the selected video from the metadata microservice.
  http.request({
    host: SVC_DNS_KIBANA,
    path: '/',
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on("error",
    err => {
      logger.error(`Failed to get details for video ${videoId}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      logger.error(err || `Status code: ${response.statusCode}.`, { app:APP_NAME_VER, service:SVC_NAME, msgId:cid });
      res.sendStatus(500);
    });
  })
  .end();
});

/***
The 404 Route
-------------
In Express, 404 responses are not the result of an error, so the error-handler middleware will not
capture them. This behavior is because a 404 response simply indicates the absence of additional
work to do; in other words, Express has executed all middleware functions and routes, and found
that none of them responded. All you need to do is add a middleware function at the VERY BOTTOM of
the stack (below all other functions) to handle a 404 response.
***/
app.use(
(req, res, next) => {
  logger.error(`Unable to find the requested resource (${req.url})!`, { app:APP_NAME_VER, service:SVC_NAME, msgId:'-1' });
  res.status(404).send(`<h1>Unable to find the requested resource (${req.url})!</h1>`);
});
