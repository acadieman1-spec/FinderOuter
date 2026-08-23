// The FinderOuter
// Copyright (c) 2020 Coding Enthusiast
// Distributed under the MIT software license, see the accompanying
// file LICENCE or http://www.opensource.org/licenses/mit-license.php.

using Avalonia.Input.Platform;
using Avalonia.Platform.Storage;
using System;
using System.Reflection;

namespace FinderOuter.ViewModels
{
    public class AboutViewModel : VmWithSizeBase
    {
        // Makes designer happy!
        public AboutViewModel()
        {
        }

        public AboutViewModel(IClipboard clipboard, ILauncher launcher)
        {
            Clipboard = clipboard;
            Launcher = launcher;
            // Window size has to be set or the new window that is build with WindowManager 
            // is going to have the same size as MainWindow
            Width = 600;
            Height = 400;
        }


        public IClipboard Clipboard { get; set; }
        public ILauncher Launcher { get; set; }
        public static string NameAndVersion => $"The FinderOuter {Assembly.GetExecutingAssembly().GetName().Version.ToString(4)}";
        public static string SourceLink => "https://github.com/Coding-Enthusiast/FinderOuter";
        public static string BitcointalkLink => "";
        public static string AvaloniaLink => "https://avaloniaui.net/";
        public static string DonationUri1 => $"bitcoin:{DonationAddr1}{Bip21Extras}";
        public static string DonationAddr1 => "1Q9swRQuwhTtjZZ2yguFWk7m7pszknkWyk";
        public static string DonationUri2 => $"bitcoin:{DonationAddr2}{Bip21Extras}";
        public static string DonationAddr2 => "bc1q3n5t9gv40ayq68nwf0yth49dt5c799wpld376s";

        private const string Bip21Extras = "?label=Coding-Enthusiast&message=Donation%20for%20FinderOuter%20project";

        public async void Copy(int i)
        {
            if (Clipboard is not null)
            {
                await Clipboard.SetTextAsync(i == 1 ? DonationAddr1 : DonationAddr2);
            }
        }
        public void Copy1() => Copy(1);
        public void Copy2() => Copy(2);

        public async void OpenBrowserAsync(string url)
        {
            await Launcher.LaunchUriAsync(new Uri(url));
        }
    }
}
