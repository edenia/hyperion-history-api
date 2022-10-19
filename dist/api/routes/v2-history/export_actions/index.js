import { addApiRoute, getRouteName } from "../../../helpers/functions.js";
import { getCreatorHandler } from "../get_creator/get_creator.js";
export default function (fastify, opts, next) {
    const schema = {
        description: 'request large action data export',
        summary: 'request large action data export',
        tags: ['history']
    };
    addApiRoute(fastify, 'GET', getRouteName(__filename), getCreatorHandler, schema);
    next();
}
