import { redirect } from '@sveltejs/kit';

export const load = ({ url }) => {
	redirect(308, `/gallery${url.search}`);
};
