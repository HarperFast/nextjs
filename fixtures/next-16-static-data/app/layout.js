export const metadata = {
	title: 'Harper - Next.js v16 Static Data App',
};

export default function RootLayout({ children }) {
	return (
		<html>
			<body>{children}</body>
		</html>
	);
}
