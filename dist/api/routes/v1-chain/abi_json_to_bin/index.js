import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Convert JSON object to binary', {
        "binargs": {
            "type": "string",
            "pattern": "^(0x)(([0-9a-f][0-9a-f])+)?$",
            "title": "Hex"
        }
    }, ["binargs"]);
    next();
}
